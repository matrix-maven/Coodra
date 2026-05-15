import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveCoodraLogsDir } from '../../lib/coodra-home.js';
import type { Check } from '../types.js';

const PRE_TOOL_LOG_PATTERN = /"event"\s*:\s*"pre_tool_use_decision"/;
const RUN_ID_FIELD_PATTERN = /"runId"\s*:\s*"[^"]+"/;
const RUN_ID_UNRESOLVED_PATTERN = /"runId"\s*:\s*"unresolved"/;

export const bridgeRunIdLogsCheck: Check = {
  id: 8,
  name: 'bridge pre_tool_use_decision logs include runId (F15 spot-check)',
  severity: 'yellow',
  async run(ctx) {
    const logsDir = resolveCoodraLogsDir(ctx.coodraHome);
    let entries: string[];
    try {
      entries = await readdir(logsDir);
    } catch {
      return { status: 'skipped', detail: `no logs at ${logsDir}` };
    }
    const candidates = entries.filter((e) => e.includes('hooks') || e.includes('bridge')).slice(0, 10);
    if (candidates.length === 0) {
      return { status: 'skipped', detail: 'no bridge log files yet' };
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let inspected = 0;
    let withRunId = 0;
    let unresolvedRunId = 0;
    for (const entry of candidates) {
      const path = join(logsDir, entry);
      let content: string;
      try {
        content = await readFile(path, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split('\n').slice(-2000);
      for (const line of lines) {
        if (!PRE_TOOL_LOG_PATTERN.test(line)) continue;
        const time = extractTime(line);
        if (time !== null && time < cutoff) continue;
        inspected += 1;
        if (RUN_ID_UNRESOLVED_PATTERN.test(line)) {
          unresolvedRunId += 1;
        } else if (RUN_ID_FIELD_PATTERN.test(line)) {
          withRunId += 1;
        }
      }
    }
    if (inspected === 0) {
      return { status: 'skipped', detail: 'no pre_tool_use_decision lines in last 24h' };
    }
    if (withRunId === inspected) {
      return { status: 'green', detail: `${inspected} pre-tool decisions all carry resolved runId` };
    }
    if (withRunId + unresolvedRunId === inspected) {
      return {
        status: 'yellow',
        detail: `${inspected} pre-tool decisions: ${withRunId} resolved, ${unresolvedRunId} 'unresolved'`,
        remediation:
          'F15 closure (commit 1cc7bbb) puts runId on every INFO log line. ' +
          "An 'unresolved' value means SessionStart hadn't created a runs row yet — generally fine.",
      };
    }
    const missing = inspected - withRunId - unresolvedRunId;
    return {
      status: 'yellow',
      detail: `${missing}/${inspected} pre-tool decision lines have no runId field at all`,
      remediation:
        'Bridge may be running pre-F15 binary. Re-run `pnpm --filter @coodra/hooks-bridge build` and restart.',
    };
  },
};

function extractTime(line: string): number | null {
  const match = line.match(/"time"\s*:\s*(\d+)/);
  if (match?.[1] !== undefined) return Number.parseInt(match[1], 10);
  return null;
}
