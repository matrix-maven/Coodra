import { closeSync, type FSWatcher, openSync, readSync, statSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * `apps/web/lib/log-tail.ts` — server-only helpers for the M04 Phase 2
 * S11 logs surface.
 *
 * `readLastLines(path, n)` reads the last `n` lines of a file without
 * loading the whole file into memory — important for `mcp-server.log`
 * which can grow into the tens of megabytes (216k lines on the dev
 * box already). Strategy: open the file, seek to end, read backwards
 * in 16KB chunks, count newlines until `n` are seen, slice off the
 * last partial line, and return the joined slice.
 *
 * `tailFromOffset(path, fromOffset)` is the SSE workhorse — given a
 * starting byte offset, returns the new lines appended since then
 * plus the new offset to resume from. Pair with `fs.watch` for
 * push-style notification of file changes.
 *
 * Service whitelist + log path mapping is centralised in
 * `LOG_FILES`. Only files in this map are reachable from the web UI;
 * any other slug returns null.
 */

export const LOG_SERVICES = ['hooks-bridge', 'mcp-server', 'sync-daemon'] as const;
export type LogService = (typeof LOG_SERVICES)[number];

export function isLogService(s: string): s is LogService {
  return (LOG_SERVICES as ReadonlyArray<string>).includes(s);
}

/**
 * Resolves the on-disk log path for a service. Honors
 * `CONTEXTOS_LOGS_DIR` (test override); else `~/.contextos/logs/`.
 */
export function logPathFor(service: LogService): string {
  const root = process.env.CONTEXTOS_LOGS_DIR ?? join(homedir(), '.contextos', 'logs');
  return join(root, `${service}.log`);
}

const READ_CHUNK = 16 * 1024;

export interface ReadLastLinesResult {
  /** Lines in chronological order (oldest first). */
  readonly lines: ReadonlyArray<string>;
  /** Byte offset to use as the starting point for tailing. */
  readonly endOffset: number;
  /** Set when the file does not exist or is unreadable. */
  readonly missing?: boolean;
}

export function readLastLines(path: string, n: number): ReadLastLinesResult {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return { lines: [], endOffset: 0, missing: true };
  }
  if (n <= 0 || size === 0) return { lines: [], endOffset: size };

  const fd = openSync(path, 'r');
  try {
    let position = size;
    let collected = '';
    let newlineCount = 0;
    const buf = Buffer.alloc(READ_CHUNK);
    // Walk backwards in READ_CHUNK chunks until we have n+1 newlines (so
    // we can drop the partial first line) or until we hit BOF.
    while (position > 0 && newlineCount <= n) {
      const readBytes = Math.min(READ_CHUNK, position);
      position -= readBytes;
      readSync(fd, buf, 0, readBytes, position);
      const chunk = buf.subarray(0, readBytes).toString('utf8');
      collected = chunk + collected;
      newlineCount = (collected.match(/\n/g) ?? []).length;
    }
    // Strip a trailing newline if present so the split doesn't yield an
    // empty tail entry.
    if (collected.endsWith('\n')) collected = collected.slice(0, -1);
    const allLines = collected.split('\n');
    const lines = allLines.slice(-n);
    return { lines, endOffset: size };
  } finally {
    closeSync(fd);
  }
}

export interface TailFromOffsetResult {
  readonly lines: ReadonlyArray<string>;
  readonly newOffset: number;
}

export function tailFromOffset(path: string, fromOffset: number): TailFromOffsetResult {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return { lines: [], newOffset: fromOffset };
  }
  if (size <= fromOffset) {
    // Either no growth, or the file was rotated/truncated. Reset to
    // current size so we don't re-emit historical content on a file
    // shrink (rotation).
    return { lines: [], newOffset: size };
  }
  const length = size - fromOffset;
  const buf = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, length, fromOffset);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString('utf8');
  // Last line may be partial (no trailing \n yet). Drop everything
  // after the last \n and rewind newOffset accordingly so the next
  // poll picks up the rest.
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline < 0) {
    // No complete line yet — wait for more data.
    return { lines: [], newOffset: fromOffset };
  }
  const completeText = text.slice(0, lastNewline);
  const lines = completeText.split('\n').filter((l) => l.length > 0);
  const newOffset = fromOffset + Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8');
  return { lines, newOffset };
}

/**
 * Watches the log file for changes and invokes `onChange` with the
 * appended lines. Returns a teardown function the caller MUST invoke
 * to release the watcher when the SSE connection closes.
 *
 * Falls back to a 1000ms polling interval when fs.watch isn't
 * supported on the platform / filesystem (NFS, WSL2 sometimes).
 */
export interface WatchOptions {
  readonly path: string;
  readonly fromOffset: number;
  readonly onLines: (lines: ReadonlyArray<string>, newOffset: number) => void;
  readonly pollMs?: number;
}

export function watchTail(opts: WatchOptions): () => void {
  let offset = opts.fromOffset;
  let watcher: FSWatcher | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let closed = false;
  const debounce = setTimeoutDebounce(60);

  function pump() {
    if (closed) return;
    const { lines, newOffset } = tailFromOffset(opts.path, offset);
    offset = newOffset;
    if (lines.length > 0) opts.onLines(lines, newOffset);
  }

  try {
    watcher = watch(opts.path, () => {
      debounce(pump);
    });
    // fs.watch doesn't fire for files that don't yet exist; if the
    // log file appears later we'll catch it on the parent dir's
    // watcher fallback. Skipped here for simplicity — log paths
    // typically already exist in solo mode.
  } catch {
    watcher = null;
  }

  // Always run a low-frequency safety poll so missed fs.watch events
  // (and the rotation/truncate detection in tailFromOffset) eventually
  // surface.
  pollTimer = setInterval(pump, opts.pollMs ?? 1500);

  // Initial pump in case lines have already accumulated since the
  // caller computed `fromOffset`.
  pump();

  return () => {
    closed = true;
    if (pollTimer !== null) clearInterval(pollTimer);
    if (watcher !== null) watcher.close();
  };
}

function setTimeoutDebounce(ms: number): (fn: () => void) => void {
  let pending: NodeJS.Timeout | null = null;
  return (fn: () => void) => {
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      fn();
    }, ms);
  };
}
