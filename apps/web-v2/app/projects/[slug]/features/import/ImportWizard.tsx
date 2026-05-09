'use client';

import { useMemo, useState } from 'react';

import { importFeaturesAction } from '@/lib/actions/features';

/**
 * Client-side import wizard. Server-rendered the candidate list; this
 * component makes each row interactive (selection, slug edit,
 * description edit) and bundles the chosen items into a single JSON
 * payload that goes to `importFeaturesAction`.
 *
 * Why a single payload field instead of indexed form fields: the
 * Server Action receives `FormData`. Indexed entries (`item-0-slug`,
 * `item-0-description`, etc.) work but lose ordering and require a
 * brittle parser. JSON-encoding the array on the client side keeps the
 * payload structured and the action's Zod parser straightforward.
 */

export interface ImportCandidate {
  readonly relPath: string;
  readonly absPath: string;
  readonly bytes: number;
  readonly modifiedAt: string;
  readonly suggestedSlug: string;
  readonly slugCollides: boolean;
  readonly suggestedDescription: string;
}

interface RowState {
  readonly checked: boolean;
  readonly slug: string;
  readonly description: string;
}

const SLUG_RE = /^[a-z0-9_-]+$/;

export function ImportWizard({
  projectSlug,
  candidates,
  existingSlugs,
}: {
  readonly projectSlug: string;
  readonly candidates: ReadonlyArray<ImportCandidate>;
  readonly existingSlugs: ReadonlyArray<string>;
}) {
  const initial = useMemo<Record<string, RowState>>(() => {
    const out: Record<string, RowState> = {};
    for (const c of candidates) {
      out[c.absPath] = {
        checked: false,
        slug: c.suggestedSlug,
        description: c.suggestedDescription,
      };
    }
    return out;
  }, [candidates]);

  const [rows, setRows] = useState<Record<string, RowState>>(initial);

  const update = (key: string, patch: Partial<RowState>) =>
    setRows((prev) => ({ ...prev, [key]: { ...(prev[key] ?? initial[key]!), ...patch } }));

  const selectedItems = candidates
    .map((c) => ({ candidate: c, row: rows[c.absPath]! }))
    .filter((p) => p.row.checked);

  // Validate every selected row. Returns an empty array when ready to submit.
  const validationErrors = selectedItems.flatMap(({ candidate, row }) => {
    const errs: string[] = [];
    if (!SLUG_RE.test(row.slug)) errs.push(`${candidate.relPath}: slug must be lowercase letters, digits, hyphens, underscores`);
    if (existingSlugs.includes(row.slug)) errs.push(`${candidate.relPath}: slug "${row.slug}" already exists under docs/features/`);
    if (row.description.trim().length < 1) errs.push(`${candidate.relPath}: description is required`);
    if (row.description.length > 2000) errs.push(`${candidate.relPath}: description ≤ 2000 chars`);
    return errs;
  });
  // Slug uniqueness within the batch.
  const seenSlugs = new Set<string>();
  for (const { row } of selectedItems) {
    if (seenSlugs.has(row.slug)) {
      validationErrors.push(`duplicate slug "${row.slug}" in this batch`);
      break;
    }
    seenSlugs.add(row.slug);
  }

  const payload = JSON.stringify(
    selectedItems.map(({ candidate, row }) => ({
      absPath: candidate.absPath,
      slug: row.slug,
      description: row.description,
    })),
  );

  const checkAll = (checked: boolean) => {
    setRows((prev) => {
      const next: Record<string, RowState> = {};
      for (const c of candidates) {
        const existing = prev[c.absPath] ?? initial[c.absPath]!;
        next[c.absPath] = { ...existing, checked };
      }
      return next;
    });
  };

  return (
    <form action={importFeaturesAction} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <input type="hidden" name="projectSlug" value={projectSlug} />
      <input type="hidden" name="payload" value={payload} />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '12px 16px',
          background: 'var(--bg-2)',
          border: '1px solid var(--rule)',
          fontFamily: 'var(--mono)',
          fontSize: 11,
        }}
      >
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => checkAll(true)}
        >
          Select all
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => checkAll(false)}
        >
          Clear
        </button>
        <span style={{ color: 'var(--ink-dim)' }}>
          {selectedItems.length} of {candidates.length} selected
        </span>
        <button
          type="submit"
          className="btn btn--accent"
          disabled={selectedItems.length === 0 || validationErrors.length > 0}
          style={{ marginLeft: 'auto' }}
        >
          Import {selectedItems.length > 0 ? `${selectedItems.length} ` : ''}feature
          {selectedItems.length === 1 ? '' : 's'}
        </button>
      </div>

      {validationErrors.length > 0 ? (
        <div
          style={{
            padding: '10px 14px',
            border: '1px solid var(--warn)',
            background: 'var(--warn-glow)',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--warn)',
          }}
        >
          <strong>{validationErrors.length} issue{validationErrors.length === 1 ? '' : 's'} to fix:</strong>
          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
            {validationErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {candidates.map((c) => {
          const row = rows[c.absPath] ?? initial[c.absPath]!;
          const slugCollides = existingSlugs.includes(row.slug);
          return (
            <div
              key={c.absPath}
              style={{
                border: `1px solid ${row.checked ? 'var(--accent)' : 'var(--rule)'}`,
                background: row.checked ? 'var(--accent-glow)' : 'transparent',
                padding: 14,
                display: 'grid',
                gridTemplateColumns: '24px 1fr',
                gap: 14,
              }}
            >
              <div style={{ paddingTop: 4 }}>
                <input
                  type="checkbox"
                  checked={row.checked}
                  onChange={(e) => update(c.absPath, { checked: e.target.checked })}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 11,
                    color: 'var(--ink)',
                    display: 'flex',
                    gap: 14,
                    flexWrap: 'wrap',
                  }}
                >
                  <span style={{ color: 'var(--ink-mute)' }}>file:</span>
                  <code>{c.relPath}</code>
                  <span style={{ color: 'var(--ink-dim)' }}>{formatBytes(c.bytes)}</span>
                </div>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                  <label style={{ flex: '0 0 240px' }}>
                    <span style={fieldLabelStyle}>Slug</span>
                    <input
                      type="text"
                      value={row.slug}
                      onChange={(e) => update(c.absPath, { slug: e.target.value })}
                      style={{
                        ...textInputStyle,
                        borderColor: SLUG_RE.test(row.slug) && !slugCollides ? 'var(--rule-strong)' : 'var(--warn)',
                      }}
                    />
                    {slugCollides ? (
                      <p style={hintErrStyle}>collides with existing feature</p>
                    ) : !SLUG_RE.test(row.slug) ? (
                      <p style={hintErrStyle}>invalid slug</p>
                    ) : null}
                  </label>
                  <label style={{ flex: 1, minWidth: 280 }}>
                    <span style={fieldLabelStyle}>Description (the agent's trigger)</span>
                    <textarea
                      rows={2}
                      value={row.description}
                      onChange={(e) => update(c.absPath, { description: e.target.value })}
                      style={textareaStyle}
                    />
                  </label>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </form>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const fieldLabelStyle: React.CSSProperties = {
  display: 'block',
  fontFamily: 'var(--mono)',
  fontSize: 9,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--ink-mute)',
  marginBottom: 4,
};

const hintErrStyle: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  color: 'var(--warn)',
  marginTop: 4,
  marginBottom: 0,
};

const textInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--bg)',
  border: '1px solid var(--rule-strong)',
  color: 'var(--ink)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--bg)',
  border: '1px solid var(--rule-strong)',
  color: 'var(--ink)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  lineHeight: 1.5,
  resize: 'vertical',
};
