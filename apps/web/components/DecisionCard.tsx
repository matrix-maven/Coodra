import { RelativeTime } from './RelativeTime';

/**
 * Renders one row from the `decisions` table per
 * `docs/feature-packs/04-web-app/wireframes/02-screens/run-detail.md`.
 * `alternatives` is stored as a JSON string in the DB; we parse it
 * defensively and render a bullet list when it's an array.
 */

export interface DecisionCardProps {
  readonly description: string;
  readonly rationale: string;
  readonly alternatives: string | null;
  readonly createdAt: Date;
}

function parseAlternatives(raw: string | null): readonly string[] {
  if (raw === null || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string');
    return [];
  } catch {
    return [];
  }
}

export function DecisionCard({ description, rationale, alternatives, createdAt }: DecisionCardProps) {
  const alts = parseAlternatives(alternatives);
  return (
    <article className="border border-border-subtle bg-bg-surface p-6">
      <h3 className="font-display text-lg font-bold text-text-primary">{description}</h3>
      <div className="mt-1 text-xs text-text-tertiary">
        <RelativeTime date={createdAt} mode="compact" />
      </div>
      <div className="mt-4 space-y-2 text-sm">
        <div>
          <span className="font-display font-bold text-text-secondary">Rationale: </span>
          <span className="text-text-primary">{rationale}</span>
        </div>
        {alts.length > 0 ? (
          <div>
            <div className="font-display font-bold text-text-secondary">Alternatives considered:</div>
            <ul className="mt-1 list-disc pl-6 text-text-primary">
              {alts.map((alt) => (
                <li key={alt}>{alt}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </article>
  );
}
