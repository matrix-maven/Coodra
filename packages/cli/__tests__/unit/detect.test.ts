import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectExistingMCPConfig, detectIDE, detectLanguages, detectProjectRoot } from '../../src/lib/detect.js';

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

describe('detectExistingMCPConfig', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'coodra-detect-mcp-'));
  });

  it('returns null when .mcp.json is absent', async () => {
    expect(await detectExistingMCPConfig(scratch)).toBeNull();
  });

  it('returns the parsed config when .mcp.json exists and is valid', async () => {
    const config = {
      mcpServers: {
        coodra: { command: '/usr/local/bin/coodra-mcp-server' },
        other: { command: 'npx', args: ['some-server'] },
      },
    };
    await writeFile(join(scratch, '.mcp.json'), JSON.stringify(config));
    const parsed = await detectExistingMCPConfig(scratch);
    expect(parsed?.mcpServers?.coodra?.command).toBe('/usr/local/bin/coodra-mcp-server');
    expect(parsed?.mcpServers?.other?.args).toEqual(['some-server']);
  });

  it('throws when .mcp.json is invalid JSON', async () => {
    await writeFile(join(scratch, '.mcp.json'), '{ invalid');
    await expect(detectExistingMCPConfig(scratch)).rejects.toThrow();
  });

  it('throws when .mcp.json schema is wrong', async () => {
    await writeFile(join(scratch, '.mcp.json'), JSON.stringify({ mcpServers: { x: {} } }));
    await expect(detectExistingMCPConfig(scratch)).rejects.toThrow();
  });
});
