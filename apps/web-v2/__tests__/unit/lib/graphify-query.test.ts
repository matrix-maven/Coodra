import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Guards on the `/graphify` read side. The interesting behaviour is not the
 * happy path — it's the refusals:
 *
 *   1. **local-only** — a team-hosted deployment has no checkout to read;
 *   2. **org scoping** — the slug is matched against `listProjects()`, which is
 *      already org-filtered, so an out-of-org slug is indistinguishable from a
 *      missing project;
 *   3. **containment** — the output directory is recorded in
 *      `.coodra/graphify.json`, a file that lives INSIDE the repository and is
 *      therefore attacker-controlled if you clone a hostile repo. Without the
 *      post-`realpath` containment check, a crafted record (or a symlink at
 *      `.coodra/graphify/out/graph.html`) turns the embed route into an
 *      arbitrary local-file reader.
 *
 * These are the tests that would fail if someone "simplified" the path handling
 * later, so they assert on the refusal reasons, not just on falsiness.
 */

const listProjectsMock = vi.fn();
const isCloudHostedWebMock = vi.fn(() => false);

vi.mock('@/lib/queries/projects', () => ({
  listProjects: () => listProjectsMock(),
}));

vi.mock('@/lib/deployment-mode', () => ({
  isCloudHostedWeb: () => isCloudHostedWebMock(),
}));

const { getGraphifyProjectDetail, listGraphifyProjects, readGraphHtml } = await import('@/lib/queries/graphify');

const GRAPH = {
  nodes: [
    { id: 'a', label: 'a.py', community: 0, source_file: 'src/a.py' },
    { id: 'b', label: 'b.py', community: 1, source_file: 'src/b.py' },
  ],
  links: [{ source: 'a', target: 'b' }],
};

let root: string;
let outsideDir: string;

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj_1',
    slug: 'probe',
    orgId: '__solo__',
    name: 'Probe',
    cwd: root,
    createdAt: new Date(0),
    runCount: 0,
    lastRunAt: null,
    ...overrides,
  };
}

/** Write a managed-layout artifact set into `root`. */
function writeManagedArtifacts(): void {
  const out = join(root, '.coodra', 'graphify', 'out');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'graph.json'), JSON.stringify(GRAPH));
  writeFileSync(join(out, 'graph.html'), '<!DOCTYPE html><html><body>graph</body></html>');
  writeFileSync(join(out, 'GRAPH_REPORT.md'), '# Graph Report\n\n- 2 nodes · 1 edges\n');
}

/** Pin an output directory in `.coodra/graphify.json` — the record the CLI writes. */
function writeRecord(outputDir: string): void {
  mkdirSync(join(root, '.coodra'), { recursive: true });
  writeFileSync(
    join(root, '.coodra', 'graphify.json'),
    JSON.stringify({
      version: 1,
      outputDir,
      graphJson: `${outputDir}/graph.json`,
      graphHtml: `${outputDir}/graph.html`,
      report: `${outputDir}/GRAPH_REPORT.md`,
      managedByCoodra: false,
    }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coodra-web-gfx-'));
  outsideDir = mkdtempSync(join(tmpdir(), 'coodra-web-outside-'));
  listProjectsMock.mockReset();
  isCloudHostedWebMock.mockReset();
  isCloudHostedWebMock.mockReturnValue(false);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
});

describe('listGraphifyProjects', () => {
  it('short-circuits on a team-hosted deployment (no local checkout)', async () => {
    isCloudHostedWebMock.mockReturnValue(true);
    const result = await listGraphifyProjects();
    expect(result).toEqual({ cloudHosted: true, projects: [] });
    expect(listProjectsMock).not.toHaveBeenCalled();
  });

  it('reports counts and the resolved output dir for a built project', async () => {
    writeManagedArtifacts();
    listProjectsMock.mockResolvedValue([project()]);

    const { projects } = await listGraphifyProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      slug: 'probe',
      hasGraph: true,
      hasHtml: true,
      hasReport: true,
      nodes: 2,
      links: 1,
      communities: 2,
      outputDir: '.coodra/graphify/out',
      managedByCoodra: true,
    });
    expect(projects[0]?.builtAt).toBeTypeOf('string');
  });

  it('renders a project with no recorded cwd as "no root" instead of guessing a path', async () => {
    listProjectsMock.mockResolvedValue([project({ cwd: null })]);
    const { projects } = await listGraphifyProjects();
    expect(projects[0]).toMatchObject({ cwd: null, hasGraph: false, outputDir: '—' });
  });

  it('sorts built projects ahead of unbuilt ones', async () => {
    writeManagedArtifacts();
    const empty = mkdtempSync(join(tmpdir(), 'coodra-web-gfx-empty-'));
    listProjectsMock.mockResolvedValue([
      project({ slug: 'aaa-unbuilt', name: 'AAA', cwd: empty }),
      project({ slug: 'zzz-built', name: 'ZZZ', cwd: root }),
    ]);
    const { projects } = await listGraphifyProjects();
    expect(projects.map((p) => p.slug)).toEqual(['zzz-built', 'aaa-unbuilt']);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('getGraphifyProjectDetail', () => {
  it('returns not_found for a slug outside the org-scoped project list', async () => {
    listProjectsMock.mockResolvedValue([project()]);
    expect(await getGraphifyProjectDetail('someone-elses-project')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('returns the summary + report for a built project', async () => {
    writeManagedArtifacts();
    listProjectsMock.mockResolvedValue([project()]);

    const result = await getGraphifyProjectDetail('probe');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.detail.summary?.counts).toEqual({ nodes: 2, links: 1, communities: 2 });
    expect(result.detail.report).toContain('# Graph Report');
    expect(result.detail.reportTruncated).toBe(false);
    expect(result.detail.embeddable).toBe(true);
  });

  it('marks a project with no artifacts as not embeddable, with a null summary', async () => {
    listProjectsMock.mockResolvedValue([project()]);
    const result = await getGraphifyProjectDetail('probe');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.detail.summary).toBeNull();
    expect(result.detail.report).toBeNull();
    expect(result.detail.embeddable).toBe(false);
  });

  it('refuses to embed when the recorded output dir escapes the project root', async () => {
    writeFileSync(join(outsideDir, 'graph.html'), '<html>secret</html>');
    writeFileSync(join(outsideDir, 'GRAPH_REPORT.md'), '# secret');
    writeRecord(outsideDir);
    listProjectsMock.mockResolvedValue([project()]);

    const result = await getGraphifyProjectDetail('probe');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.detail.embeddable).toBe(false);
    // The report is outside the root too — it must not be read into the page.
    expect(result.detail.report).toBeNull();
  });
});

describe('readGraphHtml — the embed route guard', () => {
  it('serves graph.html for a built, in-org project', async () => {
    writeManagedArtifacts();
    listProjectsMock.mockResolvedValue([project()]);
    const result = await readGraphHtml('probe');
    expect(result).toEqual({ ok: true, html: '<!DOCTYPE html><html><body>graph</body></html>' });
  });

  it('refuses on a team-hosted deployment', async () => {
    isCloudHostedWebMock.mockReturnValue(true);
    expect(await readGraphHtml('probe')).toEqual({ ok: false, reason: 'cloud_hosted' });
  });

  it('refuses an unknown / out-of-org slug', async () => {
    listProjectsMock.mockResolvedValue([project()]);
    expect(await readGraphHtml('nope')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('refuses a project with no recorded cwd', async () => {
    listProjectsMock.mockResolvedValue([project({ cwd: null })]);
    expect(await readGraphHtml('probe')).toEqual({ ok: false, reason: 'no_cwd' });
  });

  it('reports no_artifact when the graph has never been built', async () => {
    listProjectsMock.mockResolvedValue([project()]);
    expect(await readGraphHtml('probe')).toEqual({ ok: false, reason: 'no_artifact' });
  });

  it('refuses a record whose output dir points outside the project root', async () => {
    writeFileSync(join(outsideDir, 'graph.html'), '<html>secret</html>');
    writeRecord(outsideDir);
    listProjectsMock.mockResolvedValue([project()]);
    expect(await readGraphHtml('probe')).toEqual({ ok: false, reason: 'outside_root' });
  });

  it('refuses a SYMLINK planted at graph.html that escapes the root', async () => {
    const secret = join(outsideDir, 'id_rsa');
    writeFileSync(secret, 'PRIVATE KEY');
    const out = join(root, '.coodra', 'graphify', 'out');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'graph.json'), JSON.stringify(GRAPH));
    symlinkSync(secret, join(out, 'graph.html'));
    listProjectsMock.mockResolvedValue([project()]);

    // `stat` follows the symlink and reports a real file — only the realpath
    // containment check catches this.
    expect(await readGraphHtml('probe')).toEqual({ ok: false, reason: 'outside_root' });
  });
});
