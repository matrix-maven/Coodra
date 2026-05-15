import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Stdio stdout-purity test.
 *
 * This is the authoritative end-to-end check that the stderr-logging
 * contract (README "Critical invariants") is maintained across:
 *   - our `bootstrap/ensure-stderr-logging.ts` side effect,
 *   - @coodra/shared's logger reading COODRA_LOG_DESTINATION,
 *   - @coodra/db's transitively-loaded sqlite-vec loader (which
 *     would WARN via `db.sqlite-vec-loader` on this sandbox, where no
 *     DB path is provided — but nothing imports @coodra/db from
 *     the mcp-server yet; S7a does).
 *
 * The test spawns the built entrypoint via `tsx` and asserts:
 *   1. Every byte on stdout is a valid JSON-RPC frame (LSP Content-
 *      Length headers or a JSON payload body). The server writes the
 *      `initialize` response to stdout in response to our frame.
 *   2. Every byte on stderr is either empty or a sequence of
 *      line-delimited JSON pino objects (our structured logs).
 *
 * We do NOT run the full MCP SDK client here — the point is to prove
 * the framing is clean. The §24.9 manifest-e2e tests (S17) use the
 * SDK client for full protocol coverage.
 *
 * This test is a unit test (not integration) because it does not
 * require Docker or external services. It spawns a subprocess but
 * that subprocess is fully hermetic — every dependency is in the
 * workspace.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_ROOT = resolve(__dirname, '..', '..', '..');
const ENTRYPOINT = resolve(MCP_SERVER_ROOT, 'src', 'index.ts');

describe('stdio transport — stdout purity', () => {
  it('writes only JSON-RPC frames to stdout and only line-delimited JSON to stderr', async () => {
    const child = spawn(
      process.execPath,
      [
        // Run via the tsx ESM loader so we do not require a prior
        // build step. tsx is already a mcp-server devDependency.
        '--import',
        'tsx',
        ENTRYPOINT,
      ],
      {
        cwd: MCP_SERVER_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Bootstrap will set this if unset, but we verify the
          // "already set correctly" branch works too.
          COODRA_LOG_DESTINATION: 'stderr',
          COODRA_MODE: 'solo',
          NODE_ENV: 'test',
          // Defensive: keep LOG_LEVEL quiet so the subprocess does not
          // flood stderr with boot noise during this test.
          LOG_LEVEL: 'error',
          // S7a wires `createDbClient` at boot. Point it at an in-
          // memory SQLite so the test never touches the user's real
          // ~/.coodra/data.db, and so the subprocess can tear
          // down instantly on SIGTERM without leaving a WAL behind.
          COODRA_SQLITE_PATH: ':memory:',
        },
      },
    );

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

    // Send a minimal MCP initialize frame. Framing per the stdio
    // transport spec: single newline-terminated JSON, no Content-
    // Length headers (those are for the stream transport; the
    // @modelcontextprotocol/sdk stdio server uses newline framing).
    const initializeFrame = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'stdout-purity-test', version: '0.0.0' },
      },
    })}\n`;

    child.stdin.write(initializeFrame);

    // Give the subprocess a moment to respond and settle.
    await new Promise((r) => setTimeout(r, 800));
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));

    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const stderr = Buffer.concat(stderrChunks).toString('utf8');

    // --- stdout assertions ---
    // Stdout must be zero or more JSON objects, newline-delimited.
    // We do not assert the server responded (it may have started
    // exiting before sending) — we only assert purity.
    const stdoutLines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
    for (const line of stdoutLines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.jsonrpc).toBe('2.0');
    }

    // --- stderr assertions ---
    // Every non-empty line on stderr must be valid JSON (pino line).
    // Fatal startup errors are written as plain text and would fail
    // this assertion — we would rather fail here than ship a server
    // that silently interleaves plain text into logs.
    const stderrLines = stderr.split(/\r?\n/).filter((l) => l.length > 0);
    for (const line of stderrLines) {
      expect(() => JSON.parse(line), `stderr line was not JSON: ${line.slice(0, 200)}`).not.toThrow();
    }
  }, 15_000);
});
