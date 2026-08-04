import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWorkImportCommand } from '../../src/commands/work.js';

/**
 * Integration test for `coodra work import`'s issue-key validation.
 * `coodra-work` redesign: the CLI no longer pre-validates a Jira-shaped
 * key — a bad key should surface as "not found" from the provider's own
 * MCP, not a Coodra-side format rejection. Covers: non-Jira-shaped keys
 * (a different tracker's format, a bare word) are now accepted; empty or
 * whitespace-only input is still rejected (it would otherwise produce a
 * garbage empty slug/directory).
 */

interface CapturedIO {
  stdout: string[];
  stderr: string[];
  exit: number | null;
}

function makeIO(): {
  io: { writeStdout(c: string): void; writeStderr(c: string): void; exit(code: number): never };
  captured: CapturedIO;
} {
  const captured: CapturedIO = { stdout: [], stderr: [], exit: null };
  const io = {
    writeStdout(c: string) {
      captured.stdout.push(c);
    },
    writeStderr(c: string) {
      captured.stderr.push(c);
    },
    exit(code: number): never {
      captured.exit = code;
      throw new Error(`__exit__:${code}`);
    },
  };
  return { io, captured };
}

describe('coodra work import — issue key validation', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-work-import-'));
  });

  afterEach(() => {
    /* tmp cleaned by OS */
  });

  it('accepts a non-Jira-shaped key (a different tracker/manual reference)', async () => {
    const { io, captured } = makeIO();
    await expect(runWorkImportCommand('my-manual-slug', { cwd, json: true }, io)).rejects.toThrow('__exit__:0');
    const out = JSON.parse(captured.stdout.join(''));
    expect(out.ok).toBe(true);
    expect(out.externalKey).toBe('MY-MANUAL-SLUG');
  });

  it('accepts a bare word with no hyphen/number (previously rejected by the Jira regex)', async () => {
    const { io, captured } = makeIO();
    await expect(runWorkImportCommand('standalone', { cwd, json: true }, io)).rejects.toThrow('__exit__:0');
    const out = JSON.parse(captured.stdout.join(''));
    expect(out.ok).toBe(true);
  });

  it('still rejects an empty/whitespace-only key', async () => {
    const { io, captured } = makeIO();
    await expect(runWorkImportCommand('   ', { cwd, json: true }, io)).rejects.toThrow(/__exit__:\d/);
    const out = JSON.parse(captured.stdout.join(''));
    expect(out.ok).toBe(false);
    expect(out.error).toBe('bad_issue_key');
    expect(out.message).toContain('non-empty');
  });
});
