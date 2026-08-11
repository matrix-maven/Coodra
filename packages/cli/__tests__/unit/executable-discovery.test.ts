import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { findExecutableOnPath } from '../../src/lib/executable-discovery.js';

describe('findExecutableOnPath', () => {
  let binDir: string;

  beforeEach(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'coodra-path-bin-'));
  });

  it('finds executable files on POSIX PATH', async () => {
    const bin = join(binDir, 'codex');
    await writeFile(bin, '#!/bin/sh\n', 'utf8');
    await chmod(bin, 0o755);

    await expect(findExecutableOnPath('codex', { env: { PATH: binDir }, platform: 'darwin' })).resolves.toBe(bin);
  });

  it('honors PATHEXT when resolving Windows command shims', async () => {
    const bin = join(binDir, 'codex.cmd');
    await writeFile(bin, '@echo off\r\n', 'utf8');

    await expect(
      findExecutableOnPath('codex', {
        env: { PATH: `${join(tmpdir(), 'missing')};${binDir}`, PATHEXT: '.COM;.EXE;.CMD' },
        platform: 'win32',
      }),
    ).resolves.toBe(bin);
  });
});
