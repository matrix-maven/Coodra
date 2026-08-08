export interface CommandHookRunnerOptions {
  readonly agentType: 'cursor' | 'devin' | 'antigravity';
  readonly clientName: string;
  readonly mcpConfigFilename: string;
  readonly enrichPayload?: string;
}

export function commandHookRunner(options: CommandHookRunnerOptions): string {
  const enrichPayload = options.enrichPayload ?? '';
  return `import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MCP_REQUEST_TIMEOUT_MS = 8000;
const HTTP_DAEMON_TIMEOUT_MS = 800;
const HTTP_SESSION_END_TIMEOUT_MS = 18000;

function readStdin() {
  return new Promise((resolve) => {
    let body = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      body += chunk;
    });
    process.stdin.on('end', () => resolve(body));
  });
}

function loadCoodraMcpEntry() {
  const mcpPath = join(PLUGIN_ROOT, '${options.mcpConfigFilename}');
  const parsed = JSON.parse(readFileSync(mcpPath, 'utf8'));
  const servers = parsed.mcpServers || parsed;
  const entry = servers && servers.coodra;
  if (!entry || typeof entry !== 'object' || typeof entry.command !== 'string') {
    throw new Error('coodra_mcp_entry_missing');
  }
  return {
    command: entry.command,
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
    env: entry.env && typeof entry.env === 'object' ? entry.env : {},
  };
}

function parseMcpResult(response) {
  const result = response && response.result;
  const structured = result && result.structuredContent;
  if (structured && typeof structured === 'object' && structured.hookOutput) {
    return structured.hookOutput;
  }
  const firstText = result && Array.isArray(result.content) ? result.content.find((c) => c.type === 'text') : null;
  if (firstText && typeof firstText.text === 'string') {
    const parsed = JSON.parse(firstText.text);
    if (parsed && typeof parsed === 'object' && parsed.hookOutput) return parsed.hookOutput;
  }
  throw new Error('coodra_lifecycle_output_missing');
}

function callLifecycleTool(rawPayload) {
  return new Promise((resolve, reject) => {
    const entry = loadCoodraMcpEntry();
    const child = spawn(entry.command, entry.args, {
      env: { ...process.env, ...entry.env, COODRA_LOG_DESTINATION: 'stderr' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('coodra_mcp_lifecycle_timeout'));
    }, MCP_REQUEST_TIMEOUT_MS);

    function send(message) {
      child.stdin.write(JSON.stringify(message) + '\\n');
    }

    function settleWith(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(value);
    }

    function settleError(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      reject(err);
    }

    child.on('error', settleError);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const idx = buffer.indexOf('\\n');
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
          send({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'lifecycle_event', arguments: { agentType: '${options.agentType}', rawPayload } },
          });
        } else if (msg.id === 2) {
          if (msg.error) settleError(new Error(String(msg.error.message || 'coodra_lifecycle_tool_failed')));
          else settleWith(parseMcpResult(msg));
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: '${options.clientName}', version: '1.0.0' },
      },
    });
  });
}

function readCoodraRuntimeEnv() {
  const coodraHome = process.env.COODRA_HOME || join(homedir(), '.coodra');
  let localHookSecret = process.env.LOCAL_HOOK_SECRET || '';
  let mcpServerPort = process.env.MCP_SERVER_PORT || '3100';
  try {
    const envBody = readFileSync(join(coodraHome, '.env'), 'utf8');
    if (!localHookSecret) {
      const m = envBody.match(/^LOCAL_HOOK_SECRET=(\\S+)/m);
      if (m) localHookSecret = m[1];
    }
    const p = envBody.match(/^MCP_SERVER_PORT=(\\S+)/m);
    if (p) mcpServerPort = p[1];
  } catch {
    // no ~/.coodra/.env yet - HTTP path is skipped when localHookSecret stays empty.
  }
  return { coodraHome, localHookSecret, mcpServerPort: Number(mcpServerPort) || 3100 };
}

const MCP_ACCEPT_HEADER = 'application/json, text/event-stream';

function httpRoundTrip(port, path, method, headers, jsonBody, timeoutMs = HTTP_DAEMON_TIMEOUT_MS) {
  return new Promise((resolvePromise, reject) => {
    const payload = jsonBody === undefined ? undefined : JSON.stringify(jsonBody);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          accept: MCP_ACCEPT_HEADER,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolvePromise({ statusCode: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('coodra_http_daemon_timeout')));
    req.on('error', reject);
    if (payload) req.end(payload);
    else req.end();
  });
}

function parseJsonRpcResponseBody(body) {
  const trimmed = body.trim();
  if (trimmed.length === 0) throw new Error('coodra_http_daemon_empty_response');
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const dataLines = trimmed.split('\\n').filter((l) => l.startsWith('data:'));
  if (dataLines.length === 0) throw new Error('coodra_http_daemon_unparseable_response');
  return JSON.parse(dataLines[dataLines.length - 1].slice('data:'.length).trim());
}

function sessionCachePath(coodraHome) {
  return join(coodraHome, 'mcp-http-session.json');
}

function readCachedSessionId(coodraHome, port) {
  try {
    const raw = readFileSync(sessionCachePath(coodraHome), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.port === port && typeof parsed.sessionId === 'string' && parsed.sessionId) {
      return parsed.sessionId;
    }
  } catch {
    // no cache yet, or unreadable/corrupt - treat as no cache.
  }
  return null;
}

function writeCachedSessionId(coodraHome, port, sessionId) {
  try {
    writeFileSync(sessionCachePath(coodraHome), JSON.stringify({ port, sessionId }), 'utf8');
  } catch {
    // Best-effort; failed cache writes fall back to stdio on later calls if needed.
  }
}

async function initializeHttpSession(port, secret) {
  const initRes = await httpRoundTrip(port, '/mcp', 'POST', { 'x-local-hook-secret': secret }, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: '${options.clientName}-http', version: '1.0.0' },
    },
  });
  if (initRes.statusCode < 200 || initRes.statusCode >= 300) {
    throw new Error('coodra_http_daemon_init_failed_' + initRes.statusCode);
  }
  const sessionId = initRes.headers['mcp-session-id'];
  if (!sessionId) throw new Error('coodra_http_daemon_no_session_id');
  return sessionId;
}

function isSessionEnd(rawPayload) {
  const eventName = rawPayload && (rawPayload.hook_event_name || rawPayload.hookEventName);
  return Boolean(
    eventName === 'SessionEnd' || eventName === 'sessionEnd',
  );
}

async function tryToolCall(port, secret, sessionId, rawPayload) {
  const headers = { 'x-local-hook-secret': secret, 'mcp-session-id': sessionId };
  const body = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'lifecycle_event', arguments: { agentType: '${options.agentType}', rawPayload } },
  };
  const timeoutMs = isSessionEnd(rawPayload) ? HTTP_SESSION_END_TIMEOUT_MS : HTTP_DAEMON_TIMEOUT_MS;
  const res = await httpRoundTrip(port, '/mcp', 'POST', headers, body, timeoutMs);
  if (res.statusCode === 404) return { sessionInvalid: true };
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error('coodra_http_daemon_call_failed_' + res.statusCode);
  }
  return { value: parseMcpResult(parseJsonRpcResponseBody(res.body)) };
}

async function callLifecycleToolViaHttp(rawPayload, coodraHome, port, secret) {
  const cached = readCachedSessionId(coodraHome, port);
  if (cached !== null) {
    const attempt = await tryToolCall(port, secret, cached, rawPayload);
    if (!attempt.sessionInvalid) return attempt.value;
  }
  const sessionId = await initializeHttpSession(port, secret);
  writeCachedSessionId(coodraHome, port, sessionId);
  const attempt = await tryToolCall(port, secret, sessionId, rawPayload);
  if (attempt.sessionInvalid) throw new Error('coodra_http_daemon_session_invalid_after_fresh_init');
  return attempt.value;
}

const raw = await readStdin();
let payload;
try {
  payload = JSON.parse(raw || '{}');
} catch {
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}
${enrichPayload}
const { coodraHome, localHookSecret, mcpServerPort } = readCoodraRuntimeEnv();
if (localHookSecret) {
  try {
    const hookOutput = await callLifecycleToolViaHttp(payload, coodraHome, mcpServerPort, localHookSecret);
    process.stdout.write(JSON.stringify(hookOutput || {}));
    process.exit(0);
  } catch {
    // Daemon unavailable or HTTP-path failed - fall through to stdio.
  }
}

try {
  const hookOutput = await callLifecycleTool(payload);
  process.stdout.write(JSON.stringify(hookOutput || {}));
} catch {
  process.stdout.write(JSON.stringify({}));
}
`;
}
