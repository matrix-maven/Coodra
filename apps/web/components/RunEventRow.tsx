import { RelativeTime } from './RelativeTime';
import { ToolBadge } from './ToolBadge';

/**
 * Single row in the run-detail timeline per
 * `docs/feature-packs/04-web-app/wireframes/02-screens/run-detail.md`.
 * Server-rendered; the expand/collapse for tool_input is a `<details>`
 * element so it works without JS.
 */

const PHASE_GLYPH: Record<string, string> = {
  pre: '▶',
  post: '◀',
  session_start: '●',
  session_end: '●',
  turn_end: '○',
  user_prompt: '▼',
};

export interface RunEventRowProps {
  readonly phase: string;
  readonly toolName: string;
  readonly toolUseId: string;
  readonly toolInput: string;
  readonly outcome: string | null;
  readonly createdAt: Date;
}

export function RunEventRow({ phase, toolName, toolUseId, toolInput, outcome, createdAt }: RunEventRowProps) {
  const glyph = PHASE_GLYPH[phase] ?? '·';
  // Pretty-print tool_input (it's stored as a JSON string in the DB).
  let inputPretty = toolInput;
  try {
    inputPretty = JSON.stringify(JSON.parse(toolInput), null, 2);
  } catch {
    // Leave verbatim if not parseable JSON.
  }
  let outcomePretty = outcome;
  if (outcome !== null) {
    try {
      outcomePretty = JSON.stringify(JSON.parse(outcome), null, 2);
    } catch {
      // verbatim
    }
  }
  return (
    <details className="border-b border-(--color-border-subtle) py-2 [&_summary]:cursor-pointer">
      <summary className="flex items-center gap-3 px-3">
        <span className="font-mono text-sm text-(--color-text-tertiary)" title={`phase: ${phase}`}>
          {glyph}
        </span>
        <span className="w-12 font-mono text-xs uppercase text-(--color-text-tertiary)">{phase}</span>
        <ToolBadge name={toolName || '—'} />
        <span className="font-mono text-xs text-(--color-text-tertiary)">{toolUseId}</span>
        <span className="ml-auto text-xs text-(--color-text-secondary)">
          <RelativeTime date={createdAt} mode="compact" />
        </span>
      </summary>
      <div className="mt-2 space-y-2 px-3 pb-3">
        {inputPretty !== '' && inputPretty !== '{}' ? (
          <div>
            <div className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
              Tool input
            </div>
            <pre className="mt-1 overflow-x-auto bg-(--color-bg-surface) p-3 font-mono text-xs text-(--color-text-primary)">
              {inputPretty}
            </pre>
          </div>
        ) : null}
        {outcomePretty !== null ? (
          <div>
            <div className="font-display text-xs font-bold uppercase tracking-wider text-(--color-text-secondary)">
              Outcome
            </div>
            <pre className="mt-1 overflow-x-auto bg-(--color-bg-surface) p-3 font-mono text-xs text-(--color-text-primary)">
              {outcomePretty}
            </pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}
