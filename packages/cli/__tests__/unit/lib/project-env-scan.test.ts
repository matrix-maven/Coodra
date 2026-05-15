import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { scanProjectEnvForStaleMode, stripStaleModeFromProjectEnv } from '../../../src/lib/project-env-scan.js';

/**
 * Phase A (clarity-pass-plan, 2026-05-11) — project-env-scan unit tests.
 *
 * Covers the three cases that matter operationally:
 *
 *   1. Idempotency: running `--fix` against an already-clean file is a
 *      no-op; subsequent reads see the file unchanged.
 *   2. Preserving surrounding state: comments, blank lines, unrelated
 *      env keys (MCP_SERVER_PORT etc.) survive the strip. Only the
 *      target COODRA_MODE line(s) go.
 *   3. The "no file" + "file without the key" baselines: scan reports
 *      `staleModeValue=null` for both, and strip is a no-op.
 */

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'project-env-scan-'));
  mkdirSync(cwd, { recursive: true });
});

describe('scanProjectEnvForStaleMode', () => {
  it('returns exists=false when .env is missing', () => {
    const result = scanProjectEnvForStaleMode(cwd);
    expect(result.exists).toBe(false);
    expect(result.staleModeValue).toBeNull();
    expect(result.envPath).toBe(join(cwd, '.env'));
  });

  it('returns staleModeValue=null when .env exists but has no COODRA_MODE line', () => {
    writeFileSync(join(cwd, '.env'), 'MCP_SERVER_PORT=3100\nHOOKS_BRIDGE_PORT=3101\n', 'utf8');
    const result = scanProjectEnvForStaleMode(cwd);
    expect(result.exists).toBe(true);
    expect(result.staleModeValue).toBeNull();
  });

  it('returns the stale COODRA_MODE value when present', () => {
    writeFileSync(join(cwd, '.env'), 'COODRA_MODE=solo\nMCP_SERVER_PORT=3100\n', 'utf8');
    const result = scanProjectEnvForStaleMode(cwd);
    expect(result.exists).toBe(true);
    expect(result.staleModeValue).toBe('solo');
  });
});

describe('stripStaleModeFromProjectEnv', () => {
  it('strips a single COODRA_MODE line and preserves the rest of the file', () => {
    const envPath = join(cwd, '.env');
    writeFileSync(
      envPath,
      '# project-local overrides\nMCP_SERVER_PORT=3100\nCOODRA_MODE=solo\nHOOKS_BRIDGE_PORT=3101\n',
      'utf8',
    );
    const result = stripStaleModeFromProjectEnv(envPath);
    expect(result.stripped).toBe(true);
    expect(result.removedLines).toEqual(['COODRA_MODE=solo']);
    const after = readFileSync(envPath, 'utf8');
    expect(after).toContain('# project-local overrides');
    expect(after).toContain('MCP_SERVER_PORT=3100');
    expect(after).toContain('HOOKS_BRIDGE_PORT=3101');
    expect(after).not.toContain('COODRA_MODE');
  });

  it('is idempotent — running on an already-clean file is a no-op', () => {
    const envPath = join(cwd, '.env');
    const initial = 'MCP_SERVER_PORT=3100\nHOOKS_BRIDGE_PORT=3101\n';
    writeFileSync(envPath, initial, 'utf8');
    const first = stripStaleModeFromProjectEnv(envPath);
    expect(first.stripped).toBe(false);
    expect(first.removedLines).toEqual([]);
    expect(readFileSync(envPath, 'utf8')).toBe(initial);
    // Re-running after a successful strip is also a no-op.
    writeFileSync(envPath, 'COODRA_MODE=team\nFOO=bar\n', 'utf8');
    expect(stripStaleModeFromProjectEnv(envPath).stripped).toBe(true);
    const cleanBody = readFileSync(envPath, 'utf8');
    const reRun = stripStaleModeFromProjectEnv(envPath);
    expect(reRun.stripped).toBe(false);
    expect(reRun.removedLines).toEqual([]);
    expect(readFileSync(envPath, 'utf8')).toBe(cleanBody);
  });

  it('handles multiple COODRA_MODE occurrences and collapses left-behind blank lines', () => {
    const envPath = join(cwd, '.env');
    writeFileSync(
      envPath,
      'COODRA_MODE=solo\n\nMCP_SERVER_PORT=3100\n\nCOODRA_MODE=team\nHOOKS_BRIDGE_PORT=3101\n',
      'utf8',
    );
    const result = stripStaleModeFromProjectEnv(envPath);
    expect(result.stripped).toBe(true);
    expect(result.removedLines).toEqual(['COODRA_MODE=solo', 'COODRA_MODE=team']);
    const after = readFileSync(envPath, 'utf8');
    // No double-blank lines from the gaps left behind by the strip.
    expect(after).not.toMatch(/\n\n\n/);
    // The remaining keys survive.
    expect(after).toContain('MCP_SERVER_PORT=3100');
    expect(after).toContain('HOOKS_BRIDGE_PORT=3101');
    expect(after).not.toContain('COODRA_MODE');
  });
});
