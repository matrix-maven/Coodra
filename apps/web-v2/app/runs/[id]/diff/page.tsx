import { notFound } from 'next/navigation';

import { Topbar } from '@/components/Topbar';
import { fmtRelative } from '@/lib/format';
import { getRunDiff, type RunDiffViewModel } from '@/lib/queries/run-diff';
import { getRun } from '@/lib/queries/runs';

/**
 * `apps/web-v2/app/runs/[id]/diff/page.tsx` — Module 06 (Run Diff,
 * 2026-05-09). Renders the unified `git diff` captured by the bridge
 * at SessionEnd, scoped to files the agent edited during the run.
 *
 * Empty states are first-class: an absent run_diffs row means analysis
 * hasn't completed (or was skipped); a row with `error` carries one of
 * the known soft-failure codes and we render an explanatory message
 * instead of a (missing) diff.
 *
 * Server-rendered. Diff syntax-highlighting is done with a small
 * span-per-line approach (no extra dep) — `+` lines green, `-` lines
 * red, `@@` hunk headers blue, file headers bold.
 */

export const dynamic = 'force-dynamic';

export default async function RunDiffPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await params;
  const runId = decodeURIComponent(rawId);

  const [runSnapshot, diff] = await Promise.all([getRun(runId), getRunDiff(runId)]);
  if (runSnapshot === null) notFound();
  const { run } = runSnapshot;

  return (
    <>
      <Topbar crumb={`run · ${run.id.slice(0, 8)} · diff`} crumbPrefix="coodra / runs" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/02 · AUDIT · DIFF {run.id.slice(0, 8)}</div>
            <h1 className="head__title">
              Run <em>diff</em>
            </h1>
            <p className="head__lede">
              Unified `git diff` scoped to files the agent edited during this run.
              {diff?.generatedAt !== undefined ? ` · captured ${fmtRelative(diff.generatedAt)}` : ''}
            </p>
          </div>
          <div>
            <a className="btn btn--sm btn--ghost" href={`/runs/${run.id}`}>
              ← Run detail
            </a>
          </div>
        </div>

        <div className="run-summary" style={summaryGrid}>
          <Cell
            label="Base"
            value={diff?.baseSha === null || diff?.baseSha === undefined ? '—' : diff.baseSha.slice(0, 12)}
            sub="git rev-parse HEAD at SessionStart"
          />
          <Cell
            label="Head"
            value={diff?.headSha === null || diff?.headSha === undefined ? '—' : diff.headSha.slice(0, 12)}
            sub="git rev-parse HEAD at SessionEnd"
          />
          <Cell
            label="Files"
            value={diff === null ? '—' : String(diff.filesChanged.length)}
            sub={diff === null ? 'analysis pending' : 'edited in this run'}
          />
          <Cell
            label="Status"
            value={diff === null ? 'pending' : diff.error === null ? 'captured' : diff.error}
            sub={diff?.truncated === true ? 'truncated · query MCP for full' : 'unified diff below'}
          />
        </div>

        <DiffBody diff={diff} />
      </section>
    </>
  );
}

function DiffBody({ diff }: { diff: RunDiffViewModel | null }) {
  if (diff === null) {
    return (
      <div className="empty">
        <strong>
          Analysis <em>pending</em>.
        </strong>
        The bridge writes the run_diffs row on SessionEnd. If the run is still in_progress, end the session first;
        otherwise the SessionEnd hook may have fired without a cwd.
      </div>
    );
  }

  if (diff.error === 'no_base_sha') {
    return (
      <div className="empty">
        <strong>
          No git <em>baseline</em>.
        </strong>
        SessionStart did not capture a HEAD SHA for this run. Most likely cause: the project root is not a git
        repository. Initialize git (`git init` + first commit) so future sessions can capture diffs.
      </div>
    );
  }

  if (diff.error === 'no_edits_in_run') {
    return (
      <div className="empty">
        <strong>
          No <em>edits</em>.
        </strong>
        The agent had no Edit / Write / MultiEdit tool calls during this run — there is nothing to diff. If file changes
        happened via Bash (e.g. `sed -i`), they will not appear here.
      </div>
    );
  }

  if (diff.error === 'git_diff_failed') {
    return (
      <div className="empty">
        <strong>
          `git diff` <em>failed</em>.
        </strong>
        The git subprocess errored during diff capture. Stderr below.
        <pre style={preBase}>{diff.unifiedDiff}</pre>
      </div>
    );
  }

  // Success branch.
  return (
    <>
      {diff.filesChanged.length > 0 ? (
        <div style={{ marginBottom: 24 }}>
          <h2 className="card__title" style={{ marginBottom: 12 }}>
            Files <em>changed</em>
          </h2>
          <table style={fileTable}>
            <thead>
              <tr>
                <th style={th}>Path</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: 'right' }}>+</th>
                <th style={{ ...th, textAlign: 'right' }}>−</th>
              </tr>
            </thead>
            <tbody>
              {[...diff.filesChanged]
                .sort((a, b) => a.path.localeCompare(b.path))
                .map((f) => (
                  <tr key={f.path}>
                    <td style={tdPath}>
                      {f.path}
                      {f.oldPath !== undefined ? (
                        <span style={renameNote}>
                          {' '}
                          ← <code>{f.oldPath}</code>
                        </span>
                      ) : null}
                    </td>
                    <td style={tdStatus(f.status)}>{f.status}</td>
                    <td style={{ ...td, textAlign: 'right', color: 'var(--accent-add, #5fa861)' }}>+{f.additions}</td>
                    <td style={{ ...td, textAlign: 'right', color: 'var(--accent-del, #c25555)' }}>−{f.deletions}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {diff.unifiedDiff.length === 0 ? (
        <div className="empty">No textual diff — files_changed metadata only.</div>
      ) : (
        <div>
          <h2 className="card__title" style={{ marginBottom: 12 }}>
            Unified <em>diff</em>
          </h2>
          <pre style={diffPre}>{renderDiff(diff.unifiedDiff)}</pre>
          {diff.truncated ? (
            <div style={{ fontSize: 12, color: 'var(--ink-mute)', marginTop: 8 }}>
              Diff truncated — call the `query_run_diff` MCP tool with this runId for the full output.
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}

/**
 * Render a unified diff as syntax-colored React nodes. Pure styling —
 * preserves whitespace and indentation byte-for-byte.
 */
function renderDiff(diff: string): React.ReactNode {
  const lines = diff.split('\n');
  return lines.map((line, idx) => {
    let style: React.CSSProperties | undefined;
    if (line.startsWith('+++') || line.startsWith('---')) {
      style = { color: 'var(--ink)', fontWeight: 600 };
    } else if (line.startsWith('+')) {
      style = { color: 'var(--accent-add, #5fa861)' };
    } else if (line.startsWith('-')) {
      style = { color: 'var(--accent-del, #c25555)' };
    } else if (line.startsWith('@@')) {
      style = { color: 'var(--accent, #6cb3ff)' };
    } else if (line.startsWith('diff --git')) {
      style = { color: 'var(--ink)', fontWeight: 600, marginTop: idx === 0 ? 0 : 4 };
    }
    return (
      <span key={idx} style={style}>
        {line}
        {'\n'}
      </span>
    );
  });
}

const summaryGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, 1fr)',
  borderTop: '1px solid var(--rule)',
  borderBottom: '1px solid var(--rule)',
  marginBottom: 32,
};

const preBase: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--rule)',
  padding: '14px 16px',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  lineHeight: 1.6,
  color: 'var(--ink)',
  whiteSpace: 'pre-wrap',
  overflowX: 'auto',
  marginTop: 12,
};

const diffPre: React.CSSProperties = {
  ...preBase,
  whiteSpace: 'pre',
  maxHeight: 600,
};

const fileTable: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontFamily: 'var(--mono)',
  fontSize: 12,
};

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 12px',
  borderBottom: '1px solid var(--rule)',
  color: 'var(--ink-mute)',
  fontWeight: 500,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  fontSize: 10,
};

const td: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid var(--rule)',
  color: 'var(--ink)',
};

const tdPath: React.CSSProperties = { ...td, fontFamily: 'var(--mono)' };

function tdStatus(status: string): React.CSSProperties {
  const color =
    status === 'added'
      ? 'var(--accent-add, #5fa861)'
      : status === 'deleted'
        ? 'var(--accent-del, #c25555)'
        : status === 'renamed' || status === 'copied'
          ? 'var(--accent, #6cb3ff)'
          : 'var(--ink-dim)';
  return { ...td, color };
}

const renameNote: React.CSSProperties = {
  color: 'var(--ink-mute)',
  fontSize: 11,
};

function Cell({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div style={{ padding: '24px 0 24px', paddingRight: 24, borderRight: '1px solid var(--rule)' }}>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: 'var(--ink-mute)',
          marginBottom: 12,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 18,
          fontWeight: 400,
          letterSpacing: '0',
          lineHeight: 1.2,
          color: 'var(--ink)',
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10,
          color: 'var(--ink-dim)',
          marginTop: 8,
          letterSpacing: '0.06em',
        }}
      >
        {sub}
      </div>
    </div>
  );
}
