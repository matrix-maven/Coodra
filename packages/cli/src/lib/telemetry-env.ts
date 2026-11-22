import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * COOD-105 — enabling native telemetry is a machine-level, persistent switch. It lives in
 * `<COODRA_HOME>/.env` so it flows into the daemon unit env (`resolveServices` forwards every
 * `COODRA_*` key) and survives `coodra start`, reinstall and reboot, unlike a hand-edited plist.
 */

export const TELEMETRY_FLAG = 'COODRA_TELEMETRY_ENABLED';

/**
 * Set or remove one `KEY=value` line in a dotenv text, leaving every other line (comments, secrets,
 * ordering) byte-for-byte untouched. `value === null` removes the key.
 */
export function editDotenvText(text: string, key: string, value: string | null): string {
  const lines = text.length === 0 ? [] : text.split('\n');
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const out: string[] = [];
  let replaced = false;
  for (const line of lines) {
    if (pattern.test(line)) {
      if (value !== null && !replaced) {
        out.push(`${key}=${value}`);
        replaced = true;
      }
      continue; // drop duplicates and the removed key
    }
    out.push(line);
  }
  if (value !== null && !replaced) {
    // Keep a trailing newline: put the new line before the final empty element.
    if (out.length > 0 && out[out.length - 1] === '') out.splice(out.length - 1, 0, `${key}=${value}`);
    else out.push(`${key}=${value}`, '');
  }
  return out.join('\n');
}

/** Atomically update `<home>/.env`. A newly created file is private (0600): it can hold secrets. */
export function setHomeEnvKey(coodraHome: string, key: string, value: string | null): { changed: boolean } {
  const path = join(coodraHome, '.env');
  const existed = existsSync(path);
  const before = existed ? readFileSync(path, 'utf8') : '';
  const after = editDotenvText(before, key, value);
  if (after === before) return { changed: false };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, after, { encoding: 'utf8', mode: existed ? undefined : 0o600 });
  if (!existed) chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return { changed: true };
}

export function readHomeEnvKey(coodraHome: string, key: string): string | null {
  try {
    const text = readFileSync(join(coodraHome, '.env'), 'utf8');
    const match = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`, 'm').exec(text);
    return match === null ? null : (match[1] ?? '').trim().replace(/^["']|["']$/g, '');
  } catch {
    return null;
  }
}

export interface ClaudeEnvSnippetInput {
  readonly port: number;
  readonly projectSlug: string;
}

/** Shell exports that point Claude Code's OpenTelemetry logs exporter at the local receiver. */
export function claudeCodeEnvSnippet({ port, projectSlug }: ClaudeEnvSnippetInput): string {
  return [
    'export CLAUDE_CODE_ENABLE_TELEMETRY=1',
    'export OTEL_LOGS_EXPORTER=otlp',
    'export OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json',
    `export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:${port}/telemetry/claude_code/${projectSlug}/v1/logs`,
    'export OTEL_LOG_USER_PROMPTS=0',
    'export OTEL_LOG_TOOL_DETAILS=0',
    'export OTEL_LOG_TOOL_CONTENT=0',
    'export OTEL_LOG_RAW_API_BODIES=0',
    'export OTEL_LOG_ASSISTANT_RESPONSES=0',
    'export OTEL_LOGS_EXPORT_INTERVAL=1000',
  ].join('\n');
}

/**
 * Codex `config.toml` fragment (verified on codex-cli 0.171.0-alpha.13, which accepts this inline
 * exporter table). Note: Codex includes tool arguments and outputs in `codex.tool_result` even with
 * `log_user_prompt = false`; Coodra's receiver discards them, but any other exporter you add would
 * receive them.
 */
export function codexConfigSnippet({ port, projectSlug }: ClaudeEnvSnippetInput): string {
  return [
    '[otel]',
    'environment = "dev"',
    'log_user_prompt = false',
    `exporter = { otlp-http = { endpoint = "http://127.0.0.1:${port}/telemetry/codex/${projectSlug}/v1/logs", protocol = "json" } }`,
  ].join('\n');
}

export type ReceiverProbe = 'enabled' | 'disabled' | 'unreachable';

/**
 * Ask the running daemon whether the receiver is mounted. A mounted receiver answers an unknown
 * project slug with `project_not_found`; an unmounted one falls through to the generic 404.
 */
export async function probeReceiver(port: number, fetchImpl: typeof fetch = fetch): Promise<ReceiverProbe> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/telemetry/claude_code/__coodra_probe__/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"resourceLogs":[]}',
      signal: AbortSignal.timeout(2000),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    return body.error === 'project_not_found' ? 'enabled' : 'disabled';
  } catch {
    return 'unreachable';
  }
}
