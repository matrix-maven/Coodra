'use client';

import { useEffect, useState } from 'react';

/**
 * Real-time quality score for a feature description, mirroring the
 * heuristics in `@coodra/shared/features/schema::validateFrontmatterQuality`.
 *
 * The hint reads the value of the `description` field by id, debounces
 * on input, and renders a colour-coded score plus per-rule pass/fail
 * lines. The agent uses the SAME rules to decide whether to load the
 * feature, so improving the score here directly improves agent
 * selection accuracy.
 *
 * Why duplicate the rules client-side:
 *   - This is a UX nudge, not authoritative validation. The server
 *     action re-runs the same rules at write-time; the indexer surfaces
 *     them as warnings on the index. Client-side duplication is
 *     stylistic — it gives the user feedback while typing.
 *   - Pulling the shared module into the client bundle would drag in
 *     `yaml` + `zod` for ~no runtime benefit. The 4 regex checks
 *     re-implemented here are 30 lines.
 *
 * If the rule set in `@coodra/shared` evolves, the canonical
 * source is the server-side check; surface drift via a unit test on
 * `validateFrontmatterQuality` and update both sites in lock-step.
 */

interface RuleResult {
  readonly key: string;
  readonly label: string;
  readonly pass: boolean;
}

const IMPERATIVE_RE = /^(use|call|apply|pick|reach|read|run|select|choose|trigger|invoke|consult)\b/i;
const TODO_RE = /^todo\b/i;

function evaluate(description: string): { rules: RuleResult[]; score: number } {
  const desc = description.trim();
  const isLong = desc.length >= 30;
  const notTodo = !TODO_RE.test(desc) && desc.length > 0;
  const imperative = IMPERATIVE_RE.test(desc);
  const concrete =
    /`[^`]+`/.test(desc) ||
    /[a-z]+\.[a-z]+/i.test(desc) ||
    /\/[A-Za-z]/.test(desc) ||
    /\b[A-Z]{2,}\b/.test(desc);
  const rules: RuleResult[] = [
    { key: 'todo', label: 'No "TODO" placeholder', pass: notTodo },
    { key: 'len', label: '≥ 30 chars', pass: isLong },
    { key: 'imperative', label: 'Starts with "Use this when..." (or similar)', pass: imperative },
    { key: 'concrete', label: 'Names a concrete operation, file path, or acronym', pass: concrete },
  ];
  const passCount = rules.filter((r) => r.pass).length;
  const score = passCount / rules.length;
  return { rules, score };
}

export function DescriptionQualityHint({ inputId }: { readonly inputId: string }) {
  const [value, setValue] = useState<string>('');

  useEffect(() => {
    const el = document.getElementById(inputId) as HTMLTextAreaElement | HTMLInputElement | null;
    if (el === null) return;
    setValue(el.value); // initial pass for SSR-rendered defaults
    const handler = () => setValue(el.value);
    el.addEventListener('input', handler);
    return () => el.removeEventListener('input', handler);
  }, [inputId]);

  const { rules, score } = evaluate(value);
  const colour = score >= 0.99 ? 'var(--accent)' : score >= 0.5 ? '#d6a648' : 'var(--warn)';
  const tone = score >= 0.99 ? 'strong' : score >= 0.5 ? 'OK' : 'weak';
  const passCount = rules.filter((r) => r.pass).length;

  return (
    <div
      style={{
        marginTop: 8,
        padding: '10px 12px',
        border: `1px solid ${colour}`,
        background: score >= 0.5 ? 'transparent' : 'var(--warn-glow)',
        fontFamily: 'var(--mono)',
        fontSize: 11,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <span style={{ fontWeight: 600, color: colour, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          {tone} · {passCount}/{rules.length}
        </span>
        <span style={{ color: 'var(--ink-mute)' }}>
          The agent uses these rules to decide whether to load this feature. Higher score → better selection.
        </span>
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {rules.map((r) => (
          <li
            key={r.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: r.pass ? 'var(--ink)' : 'var(--ink-mute)',
              padding: '2px 0',
            }}
          >
            <span style={{ color: r.pass ? 'var(--accent)' : 'var(--warn)', width: 14, display: 'inline-block' }}>
              {r.pass ? '✓' : '○'}
            </span>
            <span>{r.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
