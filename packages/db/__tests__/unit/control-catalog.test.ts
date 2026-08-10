import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyControl,
  createControlAttestation,
  createSqliteDb,
  listControls,
  mapControlCatalogRows,
  migrateSqlite,
  sqliteSchema,
  upsertControls,
  EXTERNAL_OWNER_CONTROLS,
  NATIVE_ADVISORY_CONTROLS,
  type DbHandle,
} from '../../src/index.js';

describe('control catalog', () => {
  let handle: DbHandle;

  beforeEach(() => {
    handle = createSqliteDb({ path: ':memory:' });
    if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
    migrateSqlite(handle.db);
    handle.db.insert(sqliteSchema.projects).values({
      id: 'proj_catalog',
      orgId: 'org_dev_local',
      slug: 'catalog-project',
      name: 'Catalog Project',
    }).run();
  });

  afterEach(() => {
    if (handle.kind === 'sqlite') handle.close();
  });

  it('classifies the catalog into Coodra relevance tracks', () => {
    expect(NATIVE_ADVISORY_CONTROLS.size).toBe(20);
    expect(EXTERNAL_OWNER_CONTROLS.size).toBe(8);
    expect(classifyControl('COODRA-SEC-001')).toBe('native_advisory');
    expect(classifyControl('COODRA-IAM-002')).toBe('external_owner');
    expect(classifyControl('COODRA-GOV-001')).toBe('evidence_attestation');
  });

  it('maps workbook rows into classified controls', () => {
    const mapped = mapControlCatalogRows([
      {
        'Control ID': 'COODRA-SEC-001',
        Domain: 'Security',
        Subdomain: 'Secrets',
        'Control Name': 'No plaintext secrets',
        'Control Objective / Requirement': 'Secrets must not be committed.',
        'Minimum Evidence': 'Policy decision record',
        'Primary Owner': 'Security',
        Status: 'Active',
      },
      {
        'Control ID': 'COODRA-IAM-001',
        'Control Name': 'Identity provider ownership',
      },
      {
        'Control ID': 'not a control',
        'Control Name': 'Ignore me',
      },
    ]);

    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({
      controlKey: 'COODRA-SEC-001',
      relevanceTrack: 'native_advisory',
      implementationMode: 'advisory_rule',
      owner: 'Security',
    });
    expect(mapped[1]).toMatchObject({
      controlKey: 'COODRA-IAM-001',
      relevanceTrack: 'external_owner',
      implementationMode: 'external_reference',
    });
  });

  it('upserts controls idempotently and lists by track', async () => {
    const controls = mapControlCatalogRows([
      {
        'Control ID': 'COODRA-SEC-001',
        Domain: 'Security',
        'Control Name': 'No plaintext secrets',
      },
      {
        'Control ID': 'COODRA-GOV-001',
        Domain: 'Governance',
        'Control Name': 'Project kickoff governance',
      },
    ]).map((control) => ({ ...control, projectId: 'proj_catalog' }));

    const first = await upsertControls(handle, controls);
    expect(first.inserted).toBe(2);
    expect(first.updated).toBe(0);

    const second = await upsertControls(handle, controls.map((control) => ({ ...control, title: `${control.title} updated` })));
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(2);

    const native = await listControls(handle, { projectId: 'proj_catalog', source: 'catalog', relevanceTrack: 'native_advisory' });
    expect(native).toHaveLength(1);
    expect(native[0]?.title).toBe('No plaintext secrets updated');

    const all = await listControls(handle, { projectId: 'proj_catalog', source: 'catalog' });
    expect(all.map((control) => control.controlKey)).toEqual(['COODRA-GOV-001', 'COODRA-SEC-001']);
  });

  it('records evidence attestations for non-native controls', async () => {
    const result = await upsertControls(
      handle,
      mapControlCatalogRows([{ 'Control ID': 'COODRA-GOV-001', 'Control Name': 'Project kickoff governance' }]).map(
        (control) => ({ ...control, projectId: 'proj_catalog' }),
      ),
    );
    const control = result.controls[0];
    expect(control).toBeDefined();

    const attestation = await createControlAttestation(handle, {
      projectId: 'proj_catalog',
      controlId: control?.id as string,
      evidenceType: 'ticket',
      evidenceRef: 'COOD-34',
      evidence: { reviewer: 'security' },
    });

    expect(attestation.controlId).toBe(control?.id);
    expect(attestation.evidenceJson).toBe('{"reviewer":"security"}');
  });
});
