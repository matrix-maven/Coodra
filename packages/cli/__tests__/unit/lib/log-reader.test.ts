import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readLastNLines, readLinesSince } from '../../../src/lib/log-reader.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'log-reader-test-'));
  path = join(dir, 'service.log');
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('readLastNLines', () => {
  it('returns empty array for an empty file', async () => {
    writeFileSync(path, '');
    expect(await readLastNLines(path, 10)).toEqual([]);
  });

  it('returns all lines when file has fewer than N lines', async () => {
    writeFileSync(path, 'one\ntwo\nthree\n');
    expect(await readLastNLines(path, 10)).toEqual(['one', 'two', 'three']);
  });

  it('returns the last N lines when file has more than N lines', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`);
    writeFileSync(path, `${lines.join('\n')}\n`);
    const tail = await readLastNLines(path, 10);
    expect(tail).toHaveLength(10);
    expect(tail[0]).toBe('line-91');
    expect(tail[9]).toBe('line-100');
  });

  it('handles files larger than the chunk size correctly (8KB chunks)', async () => {
    // Each line is ~50 bytes; 1000 lines = ~50KB which spans multiple 8KB chunks.
    const lines = Array.from({ length: 1000 }, (_, i) => `line-${String(i + 1).padStart(40, '0')}`);
    writeFileSync(path, `${lines.join('\n')}\n`);
    const tail = await readLastNLines(path, 5);
    expect(tail).toHaveLength(5);
    expect(tail[4]).toBe(`line-${'1000'.padStart(40, '0')}`);
    expect(tail[0]).toBe(`line-${'996'.padStart(40, '0')}`);
  });

  it('does not include trailing empty line when file ends with newline', async () => {
    writeFileSync(path, 'a\nb\nc\n');
    const tail = await readLastNLines(path, 5);
    expect(tail).toEqual(['a', 'b', 'c']);
    expect(tail).not.toContain('');
  });
});

describe('readLinesSince', () => {
  it('returns lines whose JSON time field is at or after the cutoff', async () => {
    const lines = [
      JSON.stringify({ time: '2026-05-03T10:00:00Z', msg: 'before' }),
      JSON.stringify({ time: '2026-05-03T11:00:00Z', msg: 'on the boundary' }),
      JSON.stringify({ time: '2026-05-03T12:00:00Z', msg: 'after' }),
    ];
    writeFileSync(path, `${lines.join('\n')}\n`);
    const since = new Date('2026-05-03T11:00:00Z');
    const filtered = await readLinesSince(path, since);
    expect(filtered).toHaveLength(2);
    expect(filtered[0]).toContain('on the boundary');
    expect(filtered[1]).toContain('after');
  });

  it('keeps non-JSON lines verbatim (operator-friendly default)', async () => {
    const content = `${JSON.stringify({ time: '2026-05-03T08:00:00Z', msg: 'old' })}
[2026-05-03T12:00:00Z] some non-json log line
${JSON.stringify({ time: '2026-05-03T13:00:00Z', msg: 'new' })}
`;
    writeFileSync(path, content);
    const since = new Date('2026-05-03T11:00:00Z');
    const filtered = await readLinesSince(path, since);
    // Non-JSON line kept; old JSON line dropped; new JSON line kept.
    expect(filtered.some((l) => l.includes('some non-json log line'))).toBe(true);
    expect(filtered.some((l) => l.includes('"msg":"new"'))).toBe(true);
    expect(filtered.some((l) => l.includes('"msg":"old"'))).toBe(false);
  });
});
