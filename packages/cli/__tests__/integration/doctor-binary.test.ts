import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const distBin = resolve(here, '..', '..', 'dist', 'index.js');

/**
 * Spawns the built `dist/index.js doctor` binary against a tmp `~/.coodra/`
 * with no migrations applied — multiple checks should fail and the exit code
 * should be 2 (red findings present). Asserts the JSON output structure
 * matches the spec §4.5 schema.
 *
 * The build step runs once per integration suite; if dist/ is missing the
 * test prints a hint instead of running. CI ensures `pnpm build` runs first.
 */
describe('doctor binary — integration spawn', () => {
  let home: string;

  beforeAll(async () => {
    // distBin must exist; the build runs in CI before integration tests.
    const { existsSync } = await import('node:fs');
    if (!existsSync(distBin)) {
      throw new Error(
        `dist/index.js missing at ${distBin}. Run \`pnpm --filter @coodra/cli build\` before integration tests.`,
      );
    }
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'coodra-doctor-bin-'));
  });

  afterEach(async () => {
    // tmp cleaned by OS
  });

  it('--json against an empty home produces structured output and exits 2 (reds present)', async () => {
    const result = await execa('node', [distBin, 'doctor', '--json', '--timeout-ms', '500'], {
      env: {
        ...process.env,
        COODRA_HOME: home,
        // Force LOCAL_HOOK_SECRET and ports off the parent so the test is hermetic.
        LOCAL_HOOK_SECRET: '',
        MCP_SERVER_PORT: '53100',
        HOOKS_BRIDGE_PORT: '53101',
      },
      reject: false,
      timeout: 30_000,
    });

    expect(result.exitCode).toBe(2);
    const stdout = String(result.stdout);
    const parsed = JSON.parse(stdout) as {
      version: string;
      coodraHome: string;
      cwd: string;
      checks: Array<{ id: number; name: string; status: string }>;
      summary: { ok: number; warn: number; fail: number; skipped: number };
    };
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(parsed.coodraHome).toBe(home);
    // dec_83ba10c1 (2026-05-02): default `coodra doctor` runs the
    // essential checks for the Claude Code + solo-mode happy path.
    // Slice 5 (2026-05-03 audit §14.1) added 28+29 to that essential
    // set (claude hook registration validator + synthetic PreToolUse
    // loop test). 9 → 11 essential, 27 → 30 full.
    expect(parsed.checks).toHaveLength(11);
    // The empty-home fixture should land at least check 3 (data.db missing) red.
    const c3 = parsed.checks.find((c) => c.id === 3);
    expect(c3?.status).toBe('red');
    // Exit 2 implies summary.fail > 0.
    expect(parsed.summary.fail).toBeGreaterThan(0);
  }, 30_000);

  it('human format prints check rows + summary line', async () => {
    const result = await execa('node', [distBin, 'doctor', '--timeout-ms', '500'], {
      env: { ...process.env, COODRA_HOME: home, LOCAL_HOOK_SECRET: 'a'.repeat(64) },
      reject: false,
      timeout: 30_000,
    });

    expect(result.exitCode).toBeGreaterThanOrEqual(1); // empty home → reds, exit 2
    const stdout = String(result.stdout);
    expect(stdout).toContain('coodra doctor');
    expect(stdout).toContain('1. Node.js >= 22.16.0');
    expect(stdout).toContain('Summary:');
    // The trimmed default surface tells the user how to see the full one.
    expect(stdout).toMatch(/11 essential checks shown\. Run `coodra doctor --full`/);
  }, 30_000);

  it('--full runs the complete 36-check registry', async () => {
    const result = await execa('node', [distBin, 'doctor', '--json', '--full', '--timeout-ms', '500'], {
      env: {
        ...process.env,
        COODRA_HOME: home,
        LOCAL_HOOK_SECRET: '',
        MCP_SERVER_PORT: '53102',
        HOOKS_BRIDGE_PORT: '53103',
      },
      reject: false,
      timeout: 30_000,
      // Slice 5: --full output now exceeds the default 1MB execa stdout buffer
      // because each new check (28/29/30) carries a multi-line remediation
      // string. Bumping to 5MB keeps the test capturing complete JSON.
      maxBuffer: 5 * 1024 * 1024,
    });
    const stdout = String(result.stdout);
    const parsed = JSON.parse(stdout) as { checks: Array<{ id: number }> };
    expect(parsed.checks).toHaveLength(36);
  }, 30_000);
});
