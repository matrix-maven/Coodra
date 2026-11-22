/** Formatting helpers for the Agent telemetry pages. Pure; safe in Server Components. */

/** Provider estimate in micro-USD → "$0.1527". `null` is "unavailable", never "$0". */
export function fmtCostMicros(micros: number | null): string {
  if (micros === null) return 'unavailable';
  return `$${(micros / 1_000_000).toFixed(micros >= 1_000_000 ? 2 : 4)}`;
}

export function fmtInt(value: number): string {
  return value.toLocaleString('en-US');
}

export function fmtMs(value: number | null): string {
  if (value === null) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

export function shortId(value: string, head = 10): string {
  return value.length <= head + 6 ? value : `${value.slice(0, head)}…${value.slice(-4)}`;
}

export const STATUS_LABEL = {
  matched: 'matched',
  hook_only: 'hook-only',
  telemetry_only: 'telemetry-only',
  awaiting_arrival: 'awaiting arrival',
  not_comparable: 'not comparable',
} as const;

export const REASON_LABEL: Record<string, string> = {
  hook_key_without_native_id: 'hook record has no native tool-use id',
  telemetry_without_tool_use_id: 'telemetry row has no tool-use id',
  telemetry_channel_not_observed: 'no telemetry received for this session',
  harness_telemetry_unsupported: 'no telemetry adapter for this harness',
};

export const DISAGREEMENT_LABEL: Record<string, string> = {
  post_hook_missing: 'telemetry says success; no PostToolUse hook',
  post_hook_after_failure: 'telemetry says failure; PostToolUse hook recorded',
  pre_hook_missing: 'PostToolUse hook without a PreToolUse',
};
