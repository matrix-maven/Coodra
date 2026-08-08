import type { DecisionRow } from '@coodra/db';
import Link from 'next/link';

/**
 * Compact decision card — shared by the run detail page (decisions
 * grouped under their context pack) and the context-pack detail page
 * (decisions that pack claims). Links to `/decisions/[id]` for the full,
 * untruncated view.
 */
export function DecisionItem({ decision }: { decision: DecisionRow }) {
  return (
    <div
      style={{
        fontSize: 13,
        lineHeight: 1.6,
        color: 'var(--ink-dim)',
        padding: '10px 0',
        borderBottom: '1px solid var(--rule)',
      }}
    >
      <Link
        href={`/decisions/${encodeURIComponent(decision.id)}`}
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10,
          color: 'var(--accent)',
          letterSpacing: '0.18em',
          display: 'block',
          marginBottom: 4,
        }}
      >
        DEC_{decision.id.slice(0, 8).toUpperCase()}
      </Link>
      {decision.description}
      {decision.rationale.length > 0 ? (
        <div style={{ marginTop: 4, color: 'var(--ink-mute)' }}>{decision.rationale}</div>
      ) : null}
    </div>
  );
}
