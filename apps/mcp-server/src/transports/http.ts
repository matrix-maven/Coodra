import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { createLogger } from '@coodra/shared';
import { getRequestListener } from '@hono/node-server';
import { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';

import type { McpServerEnv } from '../config/env.js';
import type { ToolRegistry } from '../framework/tool-registry.js';
import { resolveAgentType } from '../lib/agent-type.js';
import { SOLO_IDENTITY, verifyClerkJwt, verifyLocalHookSecret } from '../lib/auth.js';

/**
 * HTTP (Streamable HTTP) transport for `@coodra/mcp-server` (S16).
 *
 * Design decisions:
 *
 * 1. **Hybrid listener, not pure-Hono.** MCP's Streamable HTTP
 *    transport writes to Node `ServerResponse` directly (response is
 *    SSE-stream-or-JSON depending on the request shape). Hono's
 *    context contract expects the handler to return a `Response`
 *    object; `@hono/node-server` has a `RESPONSE_ALREADY_SENT`
 *    sentinel for handler-owned writes but it is not re-exported from
 *    the package root, and deep-imports break under tightened
 *    `exports` fields. The cleanest solve is to dispatch `/mcp` via
 *    `createServer`'s listener directly and delegate `/healthz` (and
 *    future non-MCP routes) to Hono via `getRequestListener`.
 *
 * 2. **One shared `McpSdkServer` + one `StreamableHTTPServerTransport`**
 *    per process, not per request. The SDK transport manages its own
 *    session state internally (`sessionIdGenerator`). Construction
 *    happens at `startHttpTransport` time, once.
 *
 * 3. **Three-layer auth chain (§19 locked order):**
 *      (1) solo-bypass   — CLERK_SECRET_KEY === 'sk_test_replace_me'
 *      (2) X-Local-Hook  — header matches LOCAL_HOOK_SECRET (timing-safe)
 *      (3) Clerk JWT     — Authorization: Bearer <jwt>
 *    No match → 401. Checks happen BEFORE any read of the body —
 *    unauthenticated requests are rejected without touching the SDK
 *    transport at all.
 *
 * 4. **Auth scope:** applied to `/mcp` only. `/healthz` is unauthed
 *    so a reverse proxy / load balancer can probe it without a
 *    Clerk round-trip.
 *
 * 5. **Loopback by default.** Host defaults to `127.0.0.1` in env
 *    config. Operators explicitly set `MCP_SERVER_HOST=0.0.0.0`
 *    behind a reverse proxy for team-mode deploys.
 */

const httpLogger = createLogger('mcp-server.transport-http');

export interface HttpStartOptions {
  readonly registry: ToolRegistry;
  readonly serverName: string;
  readonly serverVersion: string;
  readonly env: McpServerEnv;
}

export interface HttpTransportHandle {
  readonly close: () => Promise<void>;
  readonly url: string;
  readonly port: number;
  readonly host: string;
}

// ---------------------------------------------------------------------------
// Auth middleware — shared by /mcp routing. Returns the resolved
// identity source for logging, or null for "unauthenticated". On
// failure, writes the 401 response and returns null so the caller
// knows the dispatch is complete.
// ---------------------------------------------------------------------------

type AuthOutcome =
  | { readonly authenticated: true; readonly source: 'solo-bypass' | 'local-hook' | 'clerk'; readonly userId: string }
  | { readonly authenticated: false };

async function authenticate(req: IncomingMessage, env: McpServerEnv): Promise<AuthOutcome> {
  // Layer 1: solo-bypass sentinel. Identity is fixed SOLO_IDENTITY.
  if (env.CLERK_SECRET_KEY === 'sk_test_replace_me' || env.COODRA_MODE === 'solo') {
    return { authenticated: true, source: 'solo-bypass', userId: SOLO_IDENTITY.userId };
  }

  // Layer 2: X-Local-Hook-Secret.
  const hookSecret = req.headers['x-local-hook-secret'];
  if (typeof hookSecret === 'string' && env.LOCAL_HOOK_SECRET) {
    if (verifyLocalHookSecret(hookSecret, env.LOCAL_HOOK_SECRET)) {
      return { authenticated: true, source: 'local-hook', userId: 'local-hook' };
    }
  }

  // Layer 3: Clerk JWT.
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length);
    try {
      const identity = await verifyClerkJwt(token, env);
      return { authenticated: true, source: 'clerk', userId: identity.userId };
    } catch {
      // Fall through to 401.
    }
  }

  return { authenticated: false };
}

function write401(res: ServerResponse, reason: string): void {
  res.writeHead(401, {
    'content-type': 'application/json',
    'www-authenticate': 'Bearer',
  });
  res.end(JSON.stringify({ error: 'unauthorized', reason }));
}

// ---------------------------------------------------------------------------
// MCP SDK Server — wires the registry into JSON-RPC handlers. Same
// shape as the stdio transport's Server construction.
// ---------------------------------------------------------------------------

function buildSdkServer(opts: HttpStartOptions, sessionId: string): McpSdkServer {
  const { registry, serverName, serverVersion } = opts;
  const server = new McpSdkServer({ name: serverName, version: serverVersion }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = registry.list();
    return { tools: tools.map((t) => ({ ...t })) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const clientName = server.getClientVersion()?.name;
    const agentType = resolveAgentType(clientName, process.env);
    const result = await registry.handleCall(name, args ?? {}, sessionId, { agentType });
    return result as unknown as CallToolResult;
  });

  return server;
}

// ---------------------------------------------------------------------------
// Hono app — handles `/healthz` and 404. `/mcp` routing is done
// outside Hono because the SDK transport writes directly to
// ServerResponse, which conflicts with Hono's Response-return model.
// ---------------------------------------------------------------------------

function buildHonoApp(): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.text('ok', 200, { 'cache-control': 'no-store' }));
  app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404));
  return app;
}

// ---------------------------------------------------------------------------
// Streamable HTTP transport boot.
// ---------------------------------------------------------------------------

export async function startHttpTransport(opts: HttpStartOptions): Promise<HttpTransportHandle> {
  const { env } = opts;
  const port = env.MCP_SERVER_PORT;
  const host = env.MCP_SERVER_HOST;

  // Hyphen separator (not colon): get_run_id validates that sessionId
  // contains no ':' because it builds runIds as
  // `run:{projectId}:{sessionId}:{uuid}` — a colon-bearing sessionId
  // breaks that encoding. Discovered in S17 e2e against the SDK Client
  // round-trip. Same fix applied to the stdio transport's session id
  // in `src/index.ts`.
  const sessionId = `http-${randomUUID()}`;
  const sdkServer = buildSdkServer(opts, sessionId);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  // Cast: the SDK's `Transport` interface declares `onclose` as a
  // required `() => void` setter while `StreamableHTTPServerTransport`'s
  // setter accepts `undefined` (matching the v1.29.0 implementation).
  // Under `exactOptionalPropertyTypes: true` this is a TS noise-mismatch
  // — runtime is fine.
  await sdkServer.connect(transport as unknown as Parameters<typeof sdkServer.connect>[0]);

  const honoApp = buildHonoApp();
  const honoListener = getRequestListener(honoApp.fetch);

  const nodeServer: HttpServer = createServer(async (req, res) => {
    const url = req.url ?? '';
    const pathname = url.split('?')[0];

    // Route /mcp (POST body, GET stream leg, and DELETE session close per MCP spec)
    // straight to the SDK transport, after auth.
    if (pathname === '/mcp') {
      try {
        const auth = await authenticate(req, env);
        if (!auth.authenticated) {
          httpLogger.warn(
            {
              event: 'http_auth_failed',
              method: req.method,
              remote: req.socket.remoteAddress,
            },
            'mcp request rejected: no valid auth layer matched',
          );
          write401(res, 'no_valid_auth_layer');
          return;
        }

        httpLogger.info(
          {
            event: 'http_mcp_request',
            method: req.method,
            authSource: auth.source,
            userId: auth.userId,
            sessionId,
          },
          'mcp request accepted',
        );

        // Parse body for POST; GET + DELETE have no body.
        let body: unknown;
        if (req.method === 'POST') {
          body = await readJsonBody(req);
        }

        await transport.handleRequest(req, res, body);
      } catch (err) {
        httpLogger.error(
          { event: 'http_mcp_handler_error', err: err instanceof Error ? err.message : String(err) },
          '/mcp handler threw',
        );
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error' }));
        } else {
          res.end();
        }
      }
      return;
    }

    // Everything else → Hono (healthz, 404, future routes).
    honoListener(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    nodeServer.once('error', reject);
    nodeServer.listen(port, host, () => {
      nodeServer.removeListener('error', reject);
      resolve();
    });
  });

  // Resolve the actual bound port — `port` may be 0 (kernel-assigned).
  const address = nodeServer.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  const url = `http://${host}:${boundPort}`;
  httpLogger.info(
    {
      event: 'http_transport_ready',
      url,
      requestedPort: port,
      boundPort,
      mode: env.COODRA_MODE,
      sessionId,
      toolCount: opts.registry.size(),
    },
    'Streamable HTTP transport listening',
  );

  return {
    url,
    port: boundPort,
    host,
    close: async () => {
      await new Promise<void>((resolve) => {
        nodeServer.close(() => resolve());
      });
      await sdkServer.close().catch(() => {
        /* idempotent */
      });
      httpLogger.info({ event: 'http_transport_closed', sessionId }, 'http transport closed');
    },
  };
}

// ---------------------------------------------------------------------------
// JSON body reader — minimal + defensive. 1 MiB cap prevents a
// trivial memory-exhaustion DoS on the /mcp POST path.
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 1_048_576 as const; // 1 MiB

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', reject);
  });
}
