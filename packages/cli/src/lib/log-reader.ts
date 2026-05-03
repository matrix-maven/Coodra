import { open } from 'node:fs/promises';

/**
 * `packages/cli/src/lib/log-reader` — pure utilities for tailing and
 * filtering log files in a Windows/macOS/Linux-portable way (no `tail`
 * shellout, no `stat` racing).
 *
 * The `--lines` path uses chunked reverse-seek so multi-MB log files
 * stay out of memory when the operator only wants the last few lines.
 * The `--since` path reads forward until the timestamp predicate is
 * satisfied (forward-only because timestamps are monotonic in append-
 * only logs and grepping backwards through ms-resolution timestamps
 * would require parsing every line anyway).
 */

const CHUNK_SIZE = 8 * 1024;
const NEWLINE = 0x0a;

/**
 * Returns the last `n` lines of the file, in original order. Trailing
 * blank line (from a file that ends with `\n`) is dropped.
 *
 * Algorithm: read 8KB chunks from end-of-file backwards, counting
 * newlines, until we have at least `n + 1` newlines OR we hit BOF.
 * Then slice to last `n` lines. The whole file is read only when the
 * file has < n lines.
 */
export async function readLastNLines(path: string, n: number): Promise<string[]> {
  if (n <= 0) return [];
  const fd = await open(path, 'r');
  try {
    const { size } = await fd.stat();
    if (size === 0) return [];

    const chunks: Buffer[] = [];
    let position = size;
    let newlineCount = 0;

    while (position > 0 && newlineCount <= n) {
      const readSize = Math.min(CHUNK_SIZE, position);
      position -= readSize;
      const buf = Buffer.alloc(readSize);
      const { bytesRead } = await fd.read(buf, 0, readSize, position);
      const slice = bytesRead === readSize ? buf : buf.subarray(0, bytesRead);
      chunks.unshift(slice);
      for (let i = 0; i < slice.length; i++) {
        if (slice[i] === NEWLINE) newlineCount++;
      }
    }

    let lines = Buffer.concat(chunks).toString('utf8').split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
    return lines.slice(-n);
  } finally {
    await fd.close();
  }
}

/**
 * Returns every line in the file with a JSON `time` field whose
 * timestamp is `>= since`. Non-JSON lines are kept (operator visibility
 * — pino-pretty output, log4js-style lines, etc.). Lines whose
 * `time` field can't be parsed as a Date are kept too (operator-
 * friendly default: never silently drop a line that the operator
 * might want to see).
 */
export async function readLinesSince(path: string, since: Date): Promise<string[]> {
  const fd = await open(path, 'r');
  try {
    const { size } = await fd.stat();
    if (size === 0) return [];
    const buf = Buffer.alloc(size);
    await fd.read(buf, 0, size, 0);
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    const sinceMs = since.getTime();
    const out: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed[0] !== '{') {
        // Non-JSON line — surface verbatim.
        out.push(line);
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as { time?: string | number };
        if (parsed.time === undefined) {
          out.push(line);
          continue;
        }
        const ts = typeof parsed.time === 'number' ? parsed.time : new Date(parsed.time).getTime();
        if (Number.isFinite(ts) && ts >= sinceMs) {
          out.push(line);
        }
      } catch {
        // Malformed JSON line — surface verbatim.
        out.push(line);
      }
    }
    return out;
  } finally {
    await fd.close();
  }
}
