import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCoodraHome } from '../../src/lib/coodra-home.js';

/**
 * Windows-readiness (2026-06-16, Core scope): `~/.coodra/` must resolve to
 * `<home>/.coodra` on Windows — NOT `%APPDATA%` and NOT the env-paths
 * Library/Preferences path. The override args (`platform`, `home`, `env`)
 * let this run deterministically on any CI runner, so the win32 contract is
 * locked even when the suite runs on Linux/macOS.
 */
describe('resolveCoodraHome — Windows', () => {
  it('returns <home>/.coodra on win32 (homedir() → C:\\Users\\<you>)', () => {
    const home = 'C:\\Users\\dev';
    const got = resolveCoodraHome({ platform: 'win32', home, env: {} });
    expect(got).toBe(join(home, '.coodra'));
  });

  it('ignores XDG_CONFIG_HOME on win32 (XDG is a Linux-only branch)', () => {
    const home = 'C:\\Users\\dev';
    const got = resolveCoodraHome({
      platform: 'win32',
      home,
      env: { XDG_CONFIG_HOME: 'C:\\some\\xdg' } as NodeJS.ProcessEnv,
    });
    expect(got).toBe(join(home, '.coodra'));
  });

  it('COODRA_HOME env override still wins on win32', () => {
    const got = resolveCoodraHome({
      platform: 'win32',
      home: 'C:\\Users\\dev',
      env: { COODRA_HOME: 'D:\\coodra-data' } as NodeJS.ProcessEnv,
    });
    expect(got).toBe('D:\\coodra-data');
  });

  it('macOS also uses <home>/.coodra (no env-paths Library/Preferences path)', () => {
    const home = '/Users/dev';
    const got = resolveCoodraHome({ platform: 'darwin', home, env: {} });
    expect(got).toBe(join(home, '.coodra'));
  });
});
