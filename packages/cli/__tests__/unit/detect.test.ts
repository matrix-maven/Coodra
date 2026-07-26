import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectIDE, detectLanguages, detectProjectRoot, resolveIdeSelection } from '../../src/lib/detect.js';

describe('detectProjectRoot', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'coodra-detect-root-'));
  });
  afterEach(() => {
    /* tmp cleaned by OS */
  });

  it('returns the deepest enclosing dir that contains package.json / pyproject / Cargo.toml / .git', async () => {
    await writeFile(join(scratch, 'package.json'), '{}');
    const sub = join(scratch, 'src', 'app');
    await mkdir(sub, { recursive: true });
    const result = await detectProjectRoot(sub);
    expect(result.root).toBe(scratch);
    expect(result.markers).toContain('package.json');
  });

  it('falls back to the cwd when no marker is found anywhere up the tree', async () => {
    const isolated = await mkdtemp(join(tmpdir(), 'coodra-detect-isolated-'));
    const sub = join(isolated, 'a', 'b');
    await mkdir(sub, { recursive: true });
    const result = await detectProjectRoot(sub);
    // Without any marker the function returns the original cwd as fallback.
    expect([isolated, sub]).toContain(result.root);
  });

  it('detects multiple markers in the same dir', async () => {
    await writeFile(join(scratch, 'package.json'), '{}');
    await writeFile(join(scratch, 'pyproject.toml'), '');
    const result = await detectProjectRoot(scratch);
    expect(result.markers).toEqual(expect.arrayContaining(['package.json', 'pyproject.toml']));
  });

  // 0.2.0-beta.1: $HOME must never be treated as a project root. Common
  // failure mode: user has ~/.git for dotfiles, runs `coodra init` from
  // ~/myproject which has no markers — pre-fix, the walk-up resolved to
  // ~ and `init` wrote CLAUDE.md / .mcp.json / docs/feature-packs/ into
  // the user's home, with the project slug taken from the home dir's
  // basename. Post-fix, the home match is rejected and cwd is the
  // fallback root, with `skippedHomeMatch` set so callers can warn.
  it('rejects $HOME as a project root when walking up from a marker-less subdirectory', async () => {
    // Simulate ~/myproject under a tmp "home" with .git in the home.
    const fakeHome = await mkdtemp(join(tmpdir(), 'coodra-fake-home-'));
    await mkdir(join(fakeHome, '.git'), { recursive: true });
    const project = join(fakeHome, 'myproject');
    await mkdir(project, { recursive: true });
    const result = await detectProjectRoot(project, { homeDir: fakeHome });
    expect(result.root).toBe(project);
    expect(result.markers).toEqual([]);
    expect(result.skippedHomeMatch).toBeDefined();
    expect(result.skippedHomeMatch?.homeDir).toBe(fakeHome);
    expect(result.skippedHomeMatch?.markers).toContain('.git');
  });

  it('still detects a real project root above home (e.g. ~/code/myrepo with .git there)', async () => {
    // Real-world: user has ~/code/myrepo with .git inside myrepo, and ~/.git
    // for dotfiles. Walking up from ~/code/myrepo/src should pick myrepo —
    // the closest non-home match — NOT skip past it to home.
    const fakeHome = await mkdtemp(join(tmpdir(), 'coodra-fake-home-mixed-'));
    await mkdir(join(fakeHome, '.git'), { recursive: true });
    const repo = join(fakeHome, 'code', 'myrepo');
    const sub = join(repo, 'src');
    await mkdir(sub, { recursive: true });
    await mkdir(join(repo, '.git'), { recursive: true });
    const result = await detectProjectRoot(sub, { homeDir: fakeHome });
    expect(result.root).toBe(repo);
    expect(result.markers).toContain('.git');
    expect(result.skippedHomeMatch).toBeUndefined();
  });

  it('does not set skippedHomeMatch when home has no markers (the common clean-home case)', async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), 'coodra-fake-home-clean-'));
    const project = join(fakeHome, 'myproject');
    await mkdir(project, { recursive: true });
    const result = await detectProjectRoot(project, { homeDir: fakeHome });
    expect(result.skippedHomeMatch).toBeUndefined();
    expect(result.markers).toEqual([]);
  });
});

describe('detectLanguages', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'coodra-detect-langs-'));
  });

  it('reports empty list when no source files', async () => {
    const langs = await detectLanguages(scratch);
    expect(langs).toEqual([]);
  });

  it('detects typescript + python from extensions', async () => {
    await writeFile(join(scratch, 'a.ts'), '');
    await writeFile(join(scratch, 'b.ts'), '');
    await writeFile(join(scratch, 'c.py'), '');
    const langs = await detectLanguages(scratch);
    // ts has 2 files vs py 1 — ts ranks first
    expect(langs[0]).toBe('typescript');
    expect(langs).toContain('python');
  });

  it('skips node_modules + dist', async () => {
    await mkdir(join(scratch, 'node_modules'), { recursive: true });
    await writeFile(join(scratch, 'node_modules', 'a.ts'), '');
    await mkdir(join(scratch, 'dist'), { recursive: true });
    await writeFile(join(scratch, 'dist', 'b.ts'), '');
    await writeFile(join(scratch, 'real.ts'), '');
    const langs = await detectLanguages(scratch);
    expect(langs).toEqual(['typescript']);
  });
});

describe('detectIDE', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'coodra-detect-ide-'));
  });

  it('returns empty list when no IDE config dir exists', async () => {
    expect(await detectIDE({ homeDir: home })).toEqual([]);
  });

  it('detects claude, cursor, windsurf when their dirs exist', async () => {
    await mkdir(join(home, '.claude'));
    await mkdir(join(home, '.cursor'));
    await mkdir(join(home, '.windsurf'));
    expect(await detectIDE({ homeDir: home })).toEqual(['claude', 'cursor', 'windsurf']);
  });

  it('returns only the IDE config dirs that exist', async () => {
    await mkdir(join(home, '.cursor'));
    expect(await detectIDE({ homeDir: home })).toEqual(['cursor']);
  });
});

describe('resolveIdeSelection — --ide flag semantics', () => {
  // The flag is an explicit override: when set, it ignores detection
  // entirely. Undefined → use detection. `all` → all four. A name (or
  // comma-separated list of names) → exactly that list.
  it('undefined flag returns the detected list unchanged', () => {
    const result = resolveIdeSelection({ flag: undefined, detected: ['claude', 'windsurf'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ides).toEqual(['claude', 'windsurf']);
  });

  it('`all` returns every supported IDE in canonical order, regardless of detection', () => {
    const result = resolveIdeSelection({ flag: 'all', detected: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ides).toEqual(['claude', 'cursor', 'windsurf', 'codex']);
  });

  it('single-name flag returns exactly that IDE, regardless of detection', () => {
    const result = resolveIdeSelection({ flag: 'codex', detected: ['claude'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ides).toEqual(['codex']);
  });

  it('comma-separated flag returns the listed IDEs in canonical order', () => {
    const result = resolveIdeSelection({ flag: 'cursor,claude,codex', detected: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ides).toEqual(['claude', 'cursor', 'codex']);
  });

  it('is case-insensitive and tolerates whitespace', () => {
    const result = resolveIdeSelection({ flag: ' Claude , WINDSURF ', detected: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ides).toEqual(['claude', 'windsurf']);
  });

  it('rejects an unknown IDE name with a clear remediation', () => {
    const result = resolveIdeSelection({ flag: 'bogus', detected: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/unknown agent 'bogus'/);
  });

  it("rejects `all` combined with other names — it's exclusive", () => {
    const result = resolveIdeSelection({ flag: 'all,claude', detected: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--ide all is exclusive/);
  });

  it('rejects an empty flag value', () => {
    const result = resolveIdeSelection({ flag: '', detected: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/--ide value is empty/);
  });

  it('deduplicates repeated names', () => {
    const result = resolveIdeSelection({ flag: 'claude,claude,cursor', detected: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ides).toEqual(['claude', 'cursor']);
  });
});
