import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..', '..');

/**
 * Locks the `npm pack --dry-run` file list — the public surface of the
 * published tarball. Spec §9 requires this so the publish-flag-day commit
 * doesn't accidentally bloat the tarball with a stray `.DS_Store` /
 * .tsbuildinfo / etc.
 *
 * The list is normalised + sorted; the assertion is on the inclusion +
 * exclusion lists, NOT on the absolute path order, so re-ordering by
 * pnpm pack does not flake the test.
 */
describe('@coodra/cli — `npm pack --dry-run` file-list lock', () => {
  it('includes only dist/, package.json, README.md (no src/, no __tests__/, no node_modules/)', async () => {
    const result = await execa('pnpm', ['pack', '--dry-run', '--json'], {
      cwd: cliRoot,
      reject: false,
      timeout: 30_000,
    });
    expect(result.exitCode).toBe(0);

    const stdout = String(result.stdout);
    // pnpm pack --json emits a JSON object as the last block of stdout.
    const jsonStart = stdout.indexOf('{');
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(stdout.slice(jsonStart)) as {
      name: string;
      files: Array<{ path: string }>;
    };
    expect(parsed.name).toBe('@coodra/cli');
    const files = parsed.files.map((f) => f.path).sort();

    // Allowed paths.
    expect(files).toContain('package.json');
    expect(files).toContain('README.md');
    const distEntries = files.filter((f) => f.startsWith('dist/'));
    expect(distEntries.length).toBeGreaterThan(0);

    // dec_83ba10c1 (2026-05-02): the published tarball MUST ship the
    // bundled runtime tree so npm-installed users get a working
    // mcp-server + hooks-bridge without monorepo paths. Lock the
    // four runtime entries here so the publish-flag-day commit
    // cannot accidentally drop them.
    expect(files).toContain('dist/index.js');
    expect(files).toContain('dist/runtime/mcp-server/index.js');
    expect(files).toContain('dist/runtime/hooks-bridge/index.js');
    const drizzleEntries = files.filter((f) => f.startsWith('dist/runtime/drizzle/'));
    expect(drizzleEntries.length, 'drizzle migrations must ship under dist/runtime/drizzle/').toBeGreaterThan(0);

    // Excluded paths.
    expect(files.find((f) => f.startsWith('src/'))).toBeUndefined();
    expect(files.find((f) => f.startsWith('__tests__/'))).toBeUndefined();
    expect(files.find((f) => f.startsWith('node_modules/'))).toBeUndefined();
    expect(files.find((f) => f.endsWith('.tsbuildinfo'))).toBeUndefined();
    expect(files.find((f) => f === '.gitignore')).toBeUndefined();
    expect(files.find((f) => f.endsWith('.test.ts'))).toBeUndefined();
    expect(files.find((f) => f.endsWith('.DS_Store'))).toBeUndefined();
  }, 30_000);
});
