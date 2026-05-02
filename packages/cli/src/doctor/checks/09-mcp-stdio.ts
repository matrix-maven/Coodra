import { execa } from 'execa';
import { bundledMigrationsDir, resolveRuntimeBinary } from '../../lib/runtime-paths.js';
import type { Check } from '../types.js';

export const mcpStdioCheck: Check = {
  id: 9,
  name: 'MCP server reachable on stdio',
  severity: 'red',
  async run(ctx) {
    let binPath: string;
    let source: 'bundled' | 'monorepo';
    try {
      const resolved = await resolveRuntimeBinary('mcp-server');
      binPath = resolved.path;
      source = resolved.source;
    } catch (err) {
      return {
        status: 'red',
        detail: `cannot resolve mcp-server binary: ${(err as Error).message}`,
        remediation:
          'For dev contributors: run `pnpm --filter @coodra/contextos-cli build` to produce the bundled runtime ' +
          'or `pnpm --filter @coodra/contextos-mcp-server build` to produce the monorepo dev dist. ' +
          'For end users: reinstall `@coodra/contextos-cli` from npm — the bundle ships in the published tarball.',
      };
    }

    try {
      // Try a fast initialize handshake: pipe a single JSON-RPC initialize and read until response.
      const message = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'doctor', version: '1' } },
      });
      const childEnv: NodeJS.ProcessEnv = { ...ctx.env, CONTEXTOS_LOG_DESTINATION: 'stderr' };
      // When probing the bundled binary, set the migrations dir env so the
      // embedded `@coodra/contextos-db` finds the SQL files in the cli's bundle.
      if (source === 'bundled') {
        const bundled = bundledMigrationsDir('sqlite');
        if (bundled !== null) {
          childEnv.CONTEXTOS_MIGRATIONS_DIR = bundled.replace(/\/sqlite$/, '').replace(/\\sqlite$/, '');
        }
      }
      const child = execa('node', [binPath, '--transport', 'stdio'], {
        input: `${message}\n`,
        timeout: Math.min(ctx.timeoutMs - 200, 1500),
        env: childEnv,
        reject: false,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const result = await child;
      const out = String(result.stdout ?? '');
      if (out.includes('"jsonrpc":"2.0"') && out.includes('"id":1')) {
        return { status: 'green', detail: `MCP server responded to initialize (${source} binary)` };
      }
      return {
        status: 'red',
        detail: `MCP stdio handshake failed (exit ${result.exitCode}); stderr=${String(result.stderr).slice(0, 200)}`,
        remediation: 'Inspect mcp-server logs; ensure dist is up to date.',
      };
    } catch (err) {
      return {
        status: 'red',
        detail: `MCP stdio probe error: ${(err as Error).message}`,
        remediation: 'Confirm mcp-server is built and Node is on PATH.',
      };
    }
  },
};
