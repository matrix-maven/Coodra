import { createHash, randomUUID } from 'node:crypto';

import { and, asc, eq, isNull } from 'drizzle-orm';

import type { DbHandle } from './client.js';
import { postgresSchema, sqliteSchema } from './schema/index.js';

export type ControlRelevanceTrack = 'native_advisory' | 'evidence_attestation' | 'external_owner';
export type ControlImplementationMode = 'advisory_rule' | 'attestation' | 'external_reference';

export interface ControlRow {
  readonly id: string;
  readonly orgId: string | null;
  readonly projectId: string | null;
  readonly controlKey: string;
  readonly source: string;
  readonly domain: string | null;
  readonly subdomain: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly owner: string | null;
  readonly relevanceTrack: ControlRelevanceTrack;
  readonly implementationMode: ControlImplementationMode;
  readonly status: string;
  readonly guidance: string | null;
  readonly sourceMetadataJson: string;
  readonly createdByUserId: string | null;
  readonly updatedByUserId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ControlAttestationRow {
  readonly id: string;
  readonly orgId: string | null;
  readonly projectId: string | null;
  readonly controlId: string;
  readonly runId: string | null;
  readonly workPackId: string | null;
  readonly status: string;
  readonly evidenceType: string;
  readonly evidenceRef: string | null;
  readonly evidenceJson: string;
  readonly notes: string | null;
  readonly createdByUserId: string | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

export interface UpsertControlInput {
  readonly orgId?: string | null;
  readonly projectId?: string | null;
  readonly controlKey: string;
  readonly source?: string;
  readonly domain?: string | null;
  readonly subdomain?: string | null;
  readonly title: string;
  readonly description?: string | null;
  readonly owner?: string | null;
  readonly relevanceTrack: ControlRelevanceTrack;
  readonly implementationMode: ControlImplementationMode;
  readonly status?: string;
  readonly guidance?: string | null;
  readonly sourceMetadata?: unknown;
  readonly createdByUserId?: string | null;
  readonly updatedByUserId?: string | null;
}

export interface UpsertControlsResult {
  readonly inserted: number;
  readonly updated: number;
  readonly controls: ReadonlyArray<ControlRow>;
}

export interface ListControlsFilter {
  readonly projectId?: string | null;
  readonly source?: string;
  readonly relevanceTrack?: ControlRelevanceTrack;
}

export interface CreateControlAttestationInput {
  readonly orgId?: string | null;
  readonly projectId?: string | null;
  readonly controlId: string;
  readonly runId?: string | null;
  readonly workPackId?: string | null;
  readonly status?: string;
  readonly evidenceType?: string;
  readonly evidenceRef?: string | null;
  readonly evidence?: unknown;
  readonly notes?: string | null;
  readonly createdByUserId?: string | null;
  readonly expiresAt?: Date | null;
}

export interface ControlCatalogInputRow {
  readonly [key: string]: unknown;
}

export const NATIVE_ADVISORY_CONTROLS = new Set([
  'COODRA-GOV-005',
  'COODRA-GOV-008',
  'COODRA-CLD-001',
  'COODRA-CLD-002',
  'COODRA-CLD-006',
  'COODRA-CLD-007',
  'COODRA-CLD-008',
  'COODRA-CLD-010',
  'COODRA-ARC-008',
  'COODRA-SEC-001',
  'COODRA-SEC-002',
  'COODRA-SEC-003',
  'COODRA-SEC-008',
  'COODRA-SEC-009',
  'COODRA-CMDB-003',
  'COODRA-CMDB-004',
  'COODRA-REL-001',
  'COODRA-REL-002',
  'COODRA-REL-006',
  'COODRA-REL-007',
] as const);

export const EXTERNAL_OWNER_CONTROLS = new Set([
  'COODRA-IAM-001',
  'COODRA-IAM-002',
  'COODRA-IAM-003',
  'COODRA-IAM-006',
  'COODRA-IAM-007',
  'COODRA-IAM-008',
  'COODRA-OPS-002',
  'COODRA-OPS-006',
] as const);

export function classifyControl(controlKey: string): ControlRelevanceTrack {
  const normalized = normalizeControlKey(controlKey);
  if (NATIVE_ADVISORY_CONTROLS.has(normalized as never)) return 'native_advisory';
  if (EXTERNAL_OWNER_CONTROLS.has(normalized as never)) return 'external_owner';
  return 'evidence_attestation';
}

export function implementationModeForTrack(track: ControlRelevanceTrack): ControlImplementationMode {
  if (track === 'native_advisory') return 'advisory_rule';
  if (track === 'external_owner') return 'external_reference';
  return 'attestation';
}

export function normalizeControlKey(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '-');
}

export function mapControlCatalogRows(rows: ReadonlyArray<ControlCatalogInputRow>): ReadonlyArray<UpsertControlInput> {
  const controls: UpsertControlInput[] = [];
  for (const row of rows) {
      const controlKey = normalizeControlKey(readCell(row, 'Control ID'));
      // Accept any `<PREFIX>-<DOMAIN>-<NNN>` control id so an org can
      // import its own catalog; the built-in templates use `COODRA-*`.
      if (!/^[A-Z][A-Z0-9]*-[A-Z]+-\d{3}$/.test(controlKey)) continue;
      const track = classifyControl(controlKey);
      controls.push({
        controlKey,
        source: 'catalog',
        domain: emptyToNull(readCell(row, 'Domain')),
        subdomain: emptyToNull(readCell(row, 'Subdomain')),
        title: readCell(row, 'Control Name') || controlKey,
        description: emptyToNull(readCell(row, 'Control Objective / Requirement')),
        owner: emptyToNull(readCell(row, 'Primary Owner')),
        relevanceTrack: track,
        implementationMode: implementationModeForTrack(track),
        status: emptyToNull(readCell(row, 'Status')) ?? 'active',
        guidance: buildControlGuidance(track, row),
        sourceMetadata: row,
      });
  }
  return controls;
}

export async function upsertControls(
  handle: DbHandle,
  inputs: ReadonlyArray<UpsertControlInput>,
): Promise<UpsertControlsResult> {
  let inserted = 0;
  let updated = 0;
  const controls: ControlRow[] = [];
  for (const input of inputs) {
    const existing = await findControl(handle, input.projectId ?? null, input.source ?? 'catalog', input.controlKey);
    const row = existing === null ? await insertControl(handle, input) : await updateControl(handle, existing.id, input);
    controls.push(row);
    if (existing === null) inserted += 1;
    else updated += 1;
  }
  return { inserted, updated, controls };
}

export async function listControls(handle: DbHandle, filter: ListControlsFilter = {}): Promise<ReadonlyArray<ControlRow>> {
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.controls;
    const predicates = buildControlPredicates(t, filter);
    const rows = await handle.db
      .select()
      .from(t)
      .where(predicates.length > 0 ? and(...predicates) : undefined)
      .orderBy(asc(t.controlKey));
    return rows.map(toControlRow);
  }
  const t = postgresSchema.controls;
  const predicates = buildControlPredicates(t, filter);
  const rows = await handle.db
    .select()
    .from(t)
    .where(predicates.length > 0 ? and(...predicates) : undefined)
    .orderBy(asc(t.controlKey));
  return rows.map(toControlRow);
}

export async function createControlAttestation(
  handle: DbHandle,
  input: CreateControlAttestationInput,
): Promise<ControlAttestationRow> {
  const row = {
    id: randomUUID(),
    orgId: input.orgId ?? null,
    projectId: input.projectId ?? null,
    controlId: input.controlId,
    runId: input.runId ?? null,
    workPackId: input.workPackId ?? null,
    status: input.status ?? 'recorded',
    evidenceType: input.evidenceType ?? 'note',
    evidenceRef: input.evidenceRef ?? null,
    evidenceJson: stringifyJson(input.evidence ?? {}),
    notes: input.notes ?? null,
    createdByUserId: input.createdByUserId ?? null,
    expiresAt: input.expiresAt ?? null,
  };
  if (handle.kind === 'sqlite') {
    const inserted = await handle.db.insert(sqliteSchema.controlAttestations).values(row).returning();
    return toControlAttestationRow(inserted[0] as typeof sqliteSchema.controlAttestations.$inferSelect);
  }
  const inserted = await handle.db.insert(postgresSchema.controlAttestations).values(row).returning();
  return toControlAttestationRow(inserted[0] as typeof postgresSchema.controlAttestations.$inferSelect);
}

async function findControl(
  handle: DbHandle,
  projectId: string | null,
  source: string,
  controlKey: string,
): Promise<ControlRow | null> {
  if (handle.kind === 'sqlite') {
    const t = sqliteSchema.controls;
    const rows = await handle.db
      .select()
      .from(t)
      .where(and(projectId === null ? isNull(t.projectId) : eq(t.projectId, projectId), eq(t.source, source), eq(t.controlKey, controlKey)))
      .limit(1);
    return rows[0] === undefined ? null : toControlRow(rows[0]);
  }
  const t = postgresSchema.controls;
  const rows = await handle.db
    .select()
    .from(t)
    .where(and(projectId === null ? isNull(t.projectId) : eq(t.projectId, projectId), eq(t.source, source), eq(t.controlKey, controlKey)))
    .limit(1);
  return rows[0] === undefined ? null : toControlRow(rows[0]);
}

async function insertControl(handle: DbHandle, input: UpsertControlInput): Promise<ControlRow> {
  const source = input.source ?? 'catalog';
  const row = {
    id: stableControlId(input.projectId ?? null, source, input.controlKey),
    orgId: input.orgId ?? null,
    projectId: input.projectId ?? null,
    controlKey: input.controlKey,
    source,
    domain: input.domain ?? null,
    subdomain: input.subdomain ?? null,
    title: input.title,
    description: input.description ?? null,
    owner: input.owner ?? null,
    relevanceTrack: input.relevanceTrack,
    implementationMode: input.implementationMode,
    status: input.status ?? 'active',
    guidance: input.guidance ?? null,
    sourceMetadataJson: stringifyJson(input.sourceMetadata ?? {}),
    createdByUserId: input.createdByUserId ?? null,
    updatedByUserId: input.updatedByUserId ?? null,
  };
  if (handle.kind === 'sqlite') {
    const inserted = await handle.db.insert(sqliteSchema.controls).values(row).returning();
    return toControlRow(inserted[0] as typeof sqliteSchema.controls.$inferSelect);
  }
  const inserted = await handle.db.insert(postgresSchema.controls).values(row).returning();
  return toControlRow(inserted[0] as typeof postgresSchema.controls.$inferSelect);
}

async function updateControl(handle: DbHandle, id: string, input: UpsertControlInput): Promise<ControlRow> {
  const update = {
    orgId: input.orgId ?? null,
    domain: input.domain ?? null,
    subdomain: input.subdomain ?? null,
    title: input.title,
    description: input.description ?? null,
    owner: input.owner ?? null,
    relevanceTrack: input.relevanceTrack,
    implementationMode: input.implementationMode,
    status: input.status ?? 'active',
    guidance: input.guidance ?? null,
    sourceMetadataJson: stringifyJson(input.sourceMetadata ?? {}),
    updatedByUserId: input.updatedByUserId ?? null,
    updatedAt: new Date(),
  };
  if (handle.kind === 'sqlite') {
    const rows = await handle.db.update(sqliteSchema.controls).set(update).where(eq(sqliteSchema.controls.id, id)).returning();
    return toControlRow(rows[0] as typeof sqliteSchema.controls.$inferSelect);
  }
  const rows = await handle.db.update(postgresSchema.controls).set(update).where(eq(postgresSchema.controls.id, id)).returning();
  return toControlRow(rows[0] as typeof postgresSchema.controls.$inferSelect);
}

function buildControlPredicates(
  table: typeof sqliteSchema.controls | typeof postgresSchema.controls,
  filter: ListControlsFilter,
) {
  const predicates = [];
  if ('projectId' in filter) {
    predicates.push(filter.projectId === null ? isNull(table.projectId) : eq(table.projectId, filter.projectId as string));
  }
  if (filter.source !== undefined) predicates.push(eq(table.source, filter.source));
  if (filter.relevanceTrack !== undefined) predicates.push(eq(table.relevanceTrack, filter.relevanceTrack));
  return predicates;
}

function toControlRow(row: typeof sqliteSchema.controls.$inferSelect | typeof postgresSchema.controls.$inferSelect): ControlRow {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    controlKey: row.controlKey,
    source: row.source,
    domain: row.domain,
    subdomain: row.subdomain,
    title: row.title,
    description: row.description,
    owner: row.owner,
    relevanceTrack: row.relevanceTrack as ControlRelevanceTrack,
    implementationMode: row.implementationMode as ControlImplementationMode,
    status: row.status,
    guidance: row.guidance,
    sourceMetadataJson: row.sourceMetadataJson,
    createdByUserId: row.createdByUserId,
    updatedByUserId: row.updatedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toControlAttestationRow(
  row: typeof sqliteSchema.controlAttestations.$inferSelect | typeof postgresSchema.controlAttestations.$inferSelect,
): ControlAttestationRow {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId,
    controlId: row.controlId,
    runId: row.runId,
    workPackId: row.workPackId,
    status: row.status,
    evidenceType: row.evidenceType,
    evidenceRef: row.evidenceRef,
    evidenceJson: row.evidenceJson,
    notes: row.notes,
    createdByUserId: row.createdByUserId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

function stableControlId(projectId: string | null, source: string, controlKey: string): string {
  const hash = createHash('sha256').update(`${projectId ?? '__global__'}:${source}:${controlKey}`).digest('hex').slice(0, 24);
  return `ctrl_${hash}`;
}

function readCell(row: ControlCatalogInputRow, header: string): string {
  const exact = row[header];
  if (exact !== undefined && exact !== null) return String(exact).trim();
  const normalizedHeader = normalizeHeader(header);
  for (const [key, value] of Object.entries(row)) {
    if (normalizeHeader(key) === normalizedHeader) return value === undefined || value === null ? '' : String(value).trim();
  }
  return '';
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function buildControlGuidance(track: ControlRelevanceTrack, row: ControlCatalogInputRow): string {
  const minimumEvidence = emptyToNull(readCell(row, 'Minimum Evidence'));
  const notes = emptyToNull(readCell(row, 'Implementation Notes'));
  const trackText =
    track === 'native_advisory'
      ? 'Native advisory: Coodra can evaluate this from agent-visible context and policy rules.'
      : track === 'external_owner'
        ? 'External-owner: Coodra stores reference metadata; enforcement belongs to the cloud/IAM/platform owner.'
        : 'Evidence/attestation: Coodra stores evidence and review records; human/process confirmation remains authoritative.';
  return [trackText, minimumEvidence !== null ? `Minimum evidence: ${minimumEvidence}` : null, notes].filter(Boolean).join('\n');
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}
