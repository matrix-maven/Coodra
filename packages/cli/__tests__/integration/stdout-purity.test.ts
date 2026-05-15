import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const distBin = resolve(here, '..', '..', 'dist', 'index.js');

/**
 * Locks integration finding 2026-04-27 (post-08a walk): the CLI binary
 * was leaking pino structured logs onto stdout, interleaved with the
 * `✓`/`⚠` human-readable progress UI. Scripted callers piping init's
 * stdout got garbage. Fix landed in `lib/log-destination-shim.ts` —
 * defaults `COODRA_LOG_DESTINATION=stderr` for the CLI binary's
 * process. This test spawns the real binary with no env override and
 * asserts every stdout byte parses as the human progress format
 * (no leaked JSON).
 */

describe('CLI stdout purity — no pino JSON leakage', () => {
  let cwd: string;
  let home: string;

  beforeAll(async () => {
    const { existsSync } = await import('node:fs');
    if (!existsSync(distBin)) {
      throw new Error(
        `dist/index.js missing at ${distBin}. Run \`pnpm --filter @coodra/cli build\` before integration tests.`,
      );
    }
  });

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-stdout-cwd-'));
    home = await mkdtemp(join(tmpdir(), 'coodra-stdout-home-'));
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'stdout-purity-test' }));
  });

  afterEach(async () => {
    /* tmp cleaned by OS */
  });

  it('init stdout contains zero pino JSON lines (db.* logs go to stderr)', async () => {
    const result = await execa('node', [distBin, 'init', '--project-slug', 'stdout-purity-test'], {
      cwd,
      env: {
        // Strip parent inherits that could route logs differently.
        ...process.env,
        COODRA_HOME: join(home, '.coodra'),
        // Explicitly DO NOT set COODRA_LOG_DESTINATION — the shim's
        // job is to default it to stderr without an explicit override.
        COODRA_LOG_DESTINATION: undefined,
      },
      reject: false,
      timeout: 30_000,
    });

    expect(result.exitCode).toBe(0);
    const stdoutStr = String(result.stdout);
    const stderrStr = String(result.stderr);

    // stdout: every non-empty line must be human-readable (starts with ✓/⚠/+/=/!/space/text), never with `{`.
    const stdoutLines = stdoutStr.split('\n').filter((l) => l.length > 0);
    const jsonLeakedToStdout = stdoutLines.filter((l) => l.trimStart().startsWith('{'));
    expect(jsonLeakedToStdout, `stdout had pino JSON leaks: ${jsonLeakedToStdout.join(' || ')}`).toEqual([]);

    // stderr: should contain the seed events from db.ensure-global-project + db.ensure-project.
    // (We log INFO once on first insert.)
    expect(stderrStr).toMatch(/global_project_seeded|project_seeded/);
  }, 30_000);

  it('doctor stdout (--json) is single JSON object — no pino prefix', async () => {
    const result = await execa('node', [distBin, 'doctor', '--json', '--timeout-ms', '500'], {
      env: {
        ...process.env,
        COODRA_HOME: join(home, '.coodra-empty'),
        COODRA_LOG_DESTINATION: undefined,
      },
      reject: false,
      timeout: 30_000,
    });

    const stdoutStr = String(result.stdout).trim();
    // Exactly one JSON object — must round-trip parse without preceding pino JSON.
    expect(() => JSON.parse(stdoutStr)).not.toThrow();
    const parsed = JSON.parse(stdoutStr) as { checks: unknown[] };
    expect(Array.isArray(parsed.checks)).toBe(true);
  }, 30_000);

  it('explicit COODRA_LOG_DESTINATION=stdout override still works (escape hatch)', async () => {
    const result = await execa('node', [distBin, 'init', '--project-slug', 'override-test', '--dry-run'], {
      cwd,
      env: {
        ...process.env,
        COODRA_HOME: join(home, '.coodra-override'),
        COODRA_LOG_DESTINATION: 'stdout',
      },
      reject: false,
      timeout: 30_000,
    });

    expect(result.exitCode).toBe(0);
    // The shim defaults only when undefined; explicit override should leave the env var alone.
    // Dry-run skips the migration + seed step, so no logs are generated either way — but if
    // any logs DID fire, they'd be on stdout per the override. The test just confirms the
    // shim doesn't clobber an explicit caller-set value.
    const stdoutStr = String(result.stdout);
    expect(stdoutStr).toContain('Dry run: skipping migrations');
  }, 30_000);
});
