import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { installTemplateAction } from '@/lib/actions/packs';
import { deleteProjectAction, renameProjectAction, resetProjectAction } from '@/lib/actions/projects';
import { cancelAllInProgressRunsAction } from '@/lib/actions/runs';
import { fmtClockSec, fmtRelative } from '@/lib/format';
import { resolveProjectFromParams } from '@/lib/project-context';
import type { ProjectHomePackInfo } from '@/lib/queries/project-home';
import { fetchProjectFeaturesSnapshot } from '@/lib/queries/features';
import { fetchProjectHomeSnapshot } from '@/lib/queries/project-home';
import { listRuns } from '@/lib/queries/runs';
import { listTemplates, type TemplateRow } from '@/lib/queries/templates';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly reset?: string;
  readonly summary?: string;
  readonly renamed?: string;
  readonly error?: string;
  readonly errorMessage?: string;
  readonly cleared?: string;
  readonly packUploaded?: string;
  readonly linked?: string;
  readonly templateInstalled?: string;
  /** "stub" when the upload replaced a `coodra init` template stub. */
  readonly replaced?: string;
}

export default async function ProjectHomePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const project = await resolveProjectFromParams(params);
  const sp = await searchParams;
  const isSentinel = project.slug === '__global__';
  const [snap, { runs }] = await Promise.all([
    fetchProjectHomeSnapshot({
      projectId: project.id,
      projectSlug: project.slug,
      projectCwd: project.cwd,
    }),
    listRuns({ projectId: project.id, limit: 6 }),
  ]);
  // Pack panel needs the cwd + template list. The cwd is project-scoped (from
  // the projects row, recorded by the bridge or CLI's init) so per-project
  // pack uploads land in `<project.cwd>/docs/feature-packs/`, not the web-v2
  // server's cwd. Falls back to web-v2 cwd for legacy rows where projects.cwd
  // is null — the FeaturePackPanel will surface a warning in that case.
  const cwd = project.cwd ?? process.cwd();
  const cwdRecorded = project.cwd !== null;
  const templates = listTemplates();
  // Features are filesystem-driven — cheap to read once per project-home
  // render. We surface counts + a quick CTA so the project home tells the
  // operator at a glance whether features have been defined or not.
  const featuresSnap = fetchProjectFeaturesSnapshot({ projectSlug: project.slug, projectCwd: cwd });

  return (
    <>
      <Topbar crumb={project.slug} crumbPrefix="coodra / projects" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/01 · PROJECT · {project.slug.toUpperCase()}</div>
            <h1 className="head__title">
              <em>{project.name}</em>.
            </h1>
            <p className="head__lede">
              Local-first audit surface for{' '}
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--ink)' }}>{project.slug}</span>. Every run leaves a
              trace; every decision survives a crash.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{project.id.slice(0, 13)}</strong>
              <br />
              {snap.activeRuns} active runs
              <br />
              {snap.denials24h} denies · 24h
            </div>
            <div className="head__actions">
              {snap.activeRuns > 0 ? (
                <form action={cancelAllInProgressRunsAction} style={{ display: 'inline' }}>
                  <input type="hidden" name="projectId" value={project.id} />
                  <input type="hidden" name="returnTo" value={`/projects/${encodeURIComponent(project.slug)}`} />
                  <button
                    className="btn btn--ghost"
                    type="submit"
                    title={`Cancel all ${snap.activeRuns} in-progress run(s) for ${project.slug}`}
                  >
                    Cancel {snap.activeRuns} stuck
                  </button>
                </form>
              ) : null}
              <Link className="btn btn--ghost" href={`/projects/${encodeURIComponent(project.slug)}/features`}>
                Features
              </Link>
              <Link className="btn btn--ghost" href={`/runs?project=${encodeURIComponent(project.slug)}`}>
                Open runs
              </Link>
              <Link className="btn" href={`/graph?project=${encodeURIComponent(project.slug)}`}>
                Graph
              </Link>
            </div>
          </div>
        </div>

        {sp.reset !== undefined ? (
          <Banner tone="ok">Project reset · {sp.summary ?? 'audit rows deleted'}.</Banner>
        ) : null}
        {sp.renamed !== undefined ? <Banner tone="ok">Project renamed (was: {sp.renamed}).</Banner> : null}
        {sp.cleared !== undefined ? (
          <Banner tone="ok">
            Cleared {sp.cleared} stuck run{sp.cleared === '1' ? '' : 's'} for this project.
          </Banner>
        ) : null}
        {sp.packUploaded !== undefined ? (
          <Banner tone="ok">
            Pack <code style={packCodeStyle}>{sp.packUploaded}</code> uploaded
            {sp.replaced === 'stub' ? <> · replaced the <code style={packCodeStyle}>coodra init</code> template stub</> : null}
            {sp.linked === '1' ? (
              <>
                {' · linked as parent of '}
                <code style={packCodeStyle}>{project.slug}</code>
              </>
            ) : null}
            . Bridge picks it up on next SessionStart.
          </Banner>
        ) : null}
        {sp.templateInstalled !== undefined ? (
          <Banner tone="ok">
            Template <code style={packCodeStyle}>{sp.templateInstalled}</code> installed onto{' '}
            <code style={packCodeStyle}>{project.slug}</code>. Auto-marker sections re-rendered.
          </Banner>
        ) : null}
        {sp.error !== undefined ? <Banner tone="warn">{sp.errorMessage ?? sp.error}</Banner> : null}

        <div className="stats">
          <div className="stat">
            <div className="stat__label">Active runs</div>
            <div className="stat__num">{snap.activeRuns === 0 ? <em>0</em> : snap.activeRuns}</div>
            <div className="stat__delta">in_progress</div>
          </div>
          <div className="stat">
            <div className="stat__label">Denials · 24h</div>
            <div className="stat__num">{snap.denials24h}</div>
            <div className="stat__delta">{snap.denials24h === 0 ? 'all clear' : 'review on policies'}</div>
          </div>
          <div className="stat">
            <div className="stat__label">Switches</div>
            <div className="stat__num">{snap.activeKillSwitches === 0 ? <em>0</em> : snap.activeKillSwitches}</div>
            <div className="stat__delta">{snap.activeKillSwitches === 0 ? 'no pauses' : 'agents paused'}</div>
          </div>
          <div className="stat">
            <div className="stat__label">Mode</div>
            <div className="stat__num" style={{ fontSize: 32 }}>
              {snap.mode}
            </div>
            <div className="stat__delta">last fetch · {fmtRelative(snap.fetchedAt)}</div>
          </div>
        </div>

        <div className="dash-grid">
          <div>
            <div className="card__head" style={{ marginBottom: 16 }}>
              <h2 className="card__title">
                Recent <em>runs</em>
              </h2>
              <span className="card__role">last 6 · this project</span>
            </div>
            <div className="dash-list">
              {runs.length === 0 ? (
                <div className="empty">
                  <strong>
                    No runs <em>yet</em>.
                  </strong>
                  Trigger a session against this project and the trace lands here.
                </div>
              ) : (
                runs.map((run) => {
                  const dotCls =
                    run.status === 'in_progress' ? 'row__dot--w' : run.status === 'cancelled' ? 'row__dot--warn' : '';
                  const verdict =
                    run.status === 'completed'
                      ? 'COMPLETE'
                      : run.status === 'in_progress'
                        ? 'RUNNING'
                        : run.status.toUpperCase();
                  const detailHref = run.status === 'in_progress' ? `/runs/${run.id}/live` : `/runs/${run.id}`;
                  return (
                    <Link key={run.id} href={detailHref} className="row" style={{ display: 'grid' }}>
                      <div className={`row__dot ${dotCls}`}></div>
                      <div className="row__main">
                        <div className="row__title">
                          {run.agentType} · <em>{run.sessionId.slice(0, 12)}</em>
                        </div>
                        <div className="row__sub">
                          run · {run.id.slice(0, 8)} · started {fmtClockSec(run.startedAt)}
                        </div>
                      </div>
                      <div className={`row__verdict ${run.status === 'in_progress' ? 'row__verdict--running' : ''}`}>
                        {verdict}
                      </div>
                      <div className="row__time">{fmtRelative(run.startedAt)}</div>
                    </Link>
                  );
                })
              )}
            </div>
          </div>

          <div>
            <div className="aside-card">
              <div className="aside-card__head">
                <h3 className="aside-card__title">
                  Latest <em>events</em>
                </h3>
                <span className="card__role">stream</span>
              </div>
              {snap.latestEvents.length === 0 ? (
                <div
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 11,
                    color: 'var(--ink-mute)',
                    letterSpacing: '0.05em',
                    padding: '24px 0',
                    textAlign: 'center',
                  }}
                >
                  No events recorded.
                </div>
              ) : (
                snap.latestEvents.map((ev, i) => (
                  <div key={ev.id} className="event" style={i === 0 ? undefined : { marginTop: 6 }}>
                    <div className="event__dot"></div>
                    <div className="event__time">{fmtClockSec(ev.createdAt)}</div>
                    <div className="event__tool">
                      {ev.phase} · <b>{ev.toolName}</b>
                    </div>
                    <div></div>
                    <div className="event__verdict">SEEN</div>
                  </div>
                ))
              )}
            </div>

            <div className="aside-card">
              <div className="aside-card__head">
                <h3 className="aside-card__title">
                  Project <em>shape</em>
                </h3>
              </div>
              <pre
                style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--rule)',
                  padding: '18px 22px',
                  fontFamily: 'var(--mono)',
                  fontSize: 11,
                  lineHeight: 1.7,
                  color: 'var(--ink)',
                  whiteSpace: 'pre',
                  overflowX: 'auto',
                }}
              >
                {`{
  "slug": "${project.slug}",
  "id":   "${project.id}",
  "org":  "${project.orgId}",
  "mode": "${snap.mode}"
}`}
              </pre>
            </div>
          </div>
        </div>

        {/* Feature Pack panel — primary + parent chain + project-scoped actions.
            Renders for every project (including the __global__ sentinel — useful
            because uploads to the global namespace also live here). */}
        <FeaturePackPanel
          projectSlug={project.slug}
          pack={snap.pack}
          templates={templates}
          cwd={cwd}
          cwdRecorded={cwdRecorded}
        />

        {/* Features panel — skill-style index. Empty state surfaces the
            "Define your first feature" CTA so onboarding from a fresh
            project lands here, not buried in /features. */}
        <div className="card" style={{ padding: 28, marginTop: 32 }}>
          <div className="card__head">
            <h2 className="card__title">
              Skill-style <em>features</em>
            </h2>
            <span className="card__role">
              {featuresSnap.features.length} feature{featuresSnap.features.length === 1 ? '' : 's'} ·{' '}
              <span style={{ color: 'var(--ink-dim)' }}>{featuresSnap.featuresRoot}</span>
            </span>
          </div>

          {featuresSnap.features.length === 0 ? (
            <div className="empty" style={{ marginTop: 12 }}>
              <strong>
                No <em>features</em> yet.
              </strong>
              Define a feature for each meaningful slice of this project — auth, billing, the import pipeline. Drop in
              any md / spec / code samples that help an agent understand it. We index the triggers; the agent picks
              what to load.
              <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <Link
                  className="btn btn--accent"
                  href={`/projects/${encodeURIComponent(project.slug)}/features/new`}
                >
                  + Define your first feature
                </Link>
                <Link
                  className="btn btn--ghost"
                  href={`/projects/${encodeURIComponent(project.slug)}/features`}
                >
                  Open features panel
                </Link>
              </div>
            </div>
          ) : (
            <>
              <div className="dash-list" style={{ marginTop: 12 }}>
                {featuresSnap.features.slice(0, 6).map((f) => (
                  <Link
                    key={f.slug}
                    href={`/projects/${encodeURIComponent(project.slug)}/features/${encodeURIComponent(f.slug)}`}
                    className="row"
                    style={{ display: 'grid', textDecoration: 'none' }}
                  >
                    <div className={`row__dot ${f.maturity === 'deprecated' ? 'row__dot--warn' : ''}`}></div>
                    <div className="row__main">
                      <div className="row__title">
                        <em>{f.slug}</em>
                        {f.maturity !== 'stable' ? (
                          <span style={{ marginLeft: 8, color: 'var(--ink-mute)', fontFamily: 'var(--mono)', fontSize: 11 }}>
                            · {f.maturity}
                          </span>
                        ) : null}
                      </div>
                      <div className="row__sub" style={{ maxWidth: 720 }}>
                        {truncate(f.description, 160)}
                      </div>
                    </div>
                    <div className="row__verdict">
                      {f.hasWarnings ? (
                        <span className="badge badge--caution">
                          <span className="badge__dot"></span>WARN
                        </span>
                      ) : (
                        <span className="badge badge--ok">
                          <span className="badge__dot"></span>OK
                        </span>
                      )}
                    </div>
                    <div className="row__time">
                      {f.fileCount} file{f.fileCount === 1 ? '' : 's'}
                    </div>
                  </Link>
                ))}
              </div>
              <div style={{ marginTop: 18, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <Link
                  className="btn btn--accent"
                  href={`/projects/${encodeURIComponent(project.slug)}/features/new`}
                >
                  + Add feature
                </Link>
                <Link
                  className="btn btn--ghost"
                  href={`/projects/${encodeURIComponent(project.slug)}/features`}
                >
                  Open features panel
                </Link>
                {featuresSnap.features.length > 6 ? (
                  <span style={{ marginLeft: 'auto', alignSelf: 'center', fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--ink-mute)' }}>
                    showing 6 of {featuresSnap.features.length}
                  </span>
                ) : null}
              </div>
            </>
          )}
        </div>

        {/* Admin: rename · reset · delete (skipped on __global__ sentinel) */}
        {!isSentinel ? (
          <>
            <div className="card" style={{ padding: 28, marginTop: 32 }}>
              <div className="card__head">
                <h2 className="card__title">
                  Project <em>admin</em>
                </h2>
                <span className="card__role">careful — these touch the real database</span>
              </div>

              <div className="dash-grid" style={{ marginTop: 12 }}>
                {/* Rename */}
                <form action={renameProjectAction} className="aside-card" style={{ marginBottom: 0 }}>
                  <h3 className="aside-card__title" style={{ marginBottom: 12 }}>
                    Rename <em>slug</em>
                  </h3>
                  <input type="hidden" name="identifier" value={project.id} />
                  <Field label="New slug" name="newSlug" placeholder="new-slug" required pattern="[a-z0-9_-]+" />
                  <Field
                    label={`Confirmation (type "${project.slug}-renamed" or whatever you typed above)`}
                    name="confirmation"
                    required
                  />
                  <button className="btn btn--sm" type="submit">
                    Rename project
                  </button>
                </form>

                {/* Reset audit + danger */}
                <div>
                  <form action={resetProjectAction} className="aside-card">
                    <h3 className="aside-card__title" style={{ marginBottom: 12 }}>
                      Reset <em>audit data</em>
                    </h3>
                    <input type="hidden" name="identifier" value={project.id} />
                    <p style={{ fontSize: 12, color: 'var(--ink-dim)', marginBottom: 10, lineHeight: 1.6 }}>
                      Drops every run / event / decision / policy_decision / context_pack for{' '}
                      <span style={{ fontFamily: 'var(--mono)', color: 'var(--ink)' }}>{project.slug}</span>. Policies
                      stay by default — tick the box to drop those too.
                    </p>
                    <label
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        marginBottom: 10,
                        fontFamily: 'var(--mono)',
                        fontSize: 11,
                        color: 'var(--ink-dim)',
                        letterSpacing: '0.04em',
                      }}
                    >
                      <input type="checkbox" name="alsoDeletePolicies" />
                      Also delete policies + kill_switches
                    </label>
                    <Field
                      label={`Type "${project.slug}" to confirm`}
                      name="confirmation"
                      required
                      placeholder={project.slug}
                    />
                    <button
                      className="btn btn--sm"
                      type="submit"
                      style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }}
                    >
                      Reset audit data
                    </button>
                  </form>

                  <form action={deleteProjectAction} className="aside-card" style={{ marginTop: 16 }}>
                    <h3 className="aside-card__title" style={{ marginBottom: 12 }}>
                      Delete <em>project</em>
                    </h3>
                    <input type="hidden" name="identifier" value={project.id} />
                    <p style={{ fontSize: 12, color: 'var(--warn)', marginBottom: 10, lineHeight: 1.6 }}>
                      Irreversible. Drops the projects row, every audit row, and every policy/kill-switch scoped to it.
                    </p>
                    <Field
                      label={`Type "${project.slug}" to confirm`}
                      name="confirmation"
                      required
                      placeholder={project.slug}
                    />
                    <button
                      className="btn btn--sm"
                      type="submit"
                      style={{
                        borderColor: 'var(--warn)',
                        color: 'var(--warn)',
                        background: 'var(--warn-glow)',
                      }}
                    >
                      Delete project
                    </button>
                  </form>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </section>
    </>
  );
}

function Field({
  label,
  name,
  placeholder,
  required,
  pattern,
}: {
  readonly label: string;
  readonly name: string;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly pattern?: string;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: 'var(--ink-mute)',
          marginBottom: 6,
          display: 'block',
        }}
      >
        {label}
      </label>
      <input
        name={name}
        placeholder={placeholder}
        required={required}
        pattern={pattern}
        style={{
          width: '100%',
          padding: '8px 12px',
          background: 'var(--bg)',
          border: '1px solid var(--rule-strong)',
          color: 'var(--ink)',
          fontFamily: 'var(--mono)',
          fontSize: 12,
          letterSpacing: '0.04em',
        }}
      />
    </div>
  );
}

function Banner({ children, tone }: { children: React.ReactNode; tone: 'ok' | 'warn' }) {
  return (
    <div
      style={{
        padding: '12px 16px',
        marginBottom: 24,
        border: `1px solid ${tone === 'warn' ? 'var(--warn)' : 'var(--accent)'}`,
        background: tone === 'warn' ? 'var(--warn-glow)' : 'var(--accent-glow)',
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: tone === 'warn' ? 'var(--warn)' : 'var(--accent)',
        letterSpacing: '0.08em',
      }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FeaturePackPanel — primary pack + parent chain + actions
// ---------------------------------------------------------------------------

function FeaturePackPanel({
  projectSlug,
  pack,
  templates,
  cwd,
  cwdRecorded,
}: {
  readonly projectSlug: string;
  readonly pack: ProjectHomePackInfo;
  readonly templates: ReadonlyArray<TemplateRow>;
  readonly cwd: string;
  readonly cwdRecorded: boolean;
}) {
  const uploadHref = `/projects/${encodeURIComponent(projectSlug)}/packs/new`;
  const returnTo = `/projects/${encodeURIComponent(projectSlug)}`;

  return (
    <div className="card" style={{ padding: 28, marginTop: 32 }}>
      <div className="card__head">
        <h2 className="card__title">
          Feature <em>pack</em>
        </h2>
        <span className="card__role">
          auto-injected on SessionStart · <span style={{ color: 'var(--ink-dim)' }}>{pack.packsRoot}</span>
        </span>
      </div>

      {!cwdRecorded ? (
        <Banner tone="warn">
          This project has no recorded <code style={packCodeStyle}>cwd</code> — the pack panel is reading from the web
          server&apos;s working directory (<code style={packCodeStyle}>{pack.packsRoot}</code>), which may not be the
          project&apos;s real folder. Open a Claude Code session inside the project root once to register it (the bridge
          writes <code style={packCodeStyle}>projects.cwd</code> on first SessionStart), or re-run{' '}
          <code style={packCodeStyle}>coodra init</code>.
        </Banner>
      ) : null}

      {pack.cycleDetected ? (
        <Banner tone="warn">
          Pack chain has a cycle — fix <code style={packCodeStyle}>meta.json:parentSlug</code> on one of the linked
          packs. The MCP-side <code style={packCodeStyle}>get_feature_pack</code> will refuse to load until resolved.
        </Banner>
      ) : null}
      {pack.missingAncestor !== null ? (
        <Banner tone="warn">
          Ancestor <code style={packCodeStyle}>{pack.missingAncestor}</code> referenced as a parent but missing on disk.
          Re-upload it, or clear the offending <code style={packCodeStyle}>parentSlug</code>.
        </Banner>
      ) : null}

      {pack.primary?.isTemplateStub === true ? (
        <Banner tone="ok">
          Primary pack is a <code style={packCodeStyle}>coodra init</code> template stub — uploading via{' '}
          <strong>+ Upload pack</strong> below will silently replace it (no force-overwrite needed). Tip: next time, run{' '}
          <code style={packCodeStyle}>coodra init --feature-pack=empty</code> to skip the template scaffold and
          upload your own <code style={packCodeStyle}>.md</code> from the start.
        </Banner>
      ) : null}

      {pack.primary === null ? (
        <div className="empty" style={{ marginTop: 12 }}>
          <strong>
            No primary pack <em>yet</em>.
          </strong>
          The bridge skips <code style={packCodeStyle}>additionalContext</code> on SessionStart until{' '}
          <code style={packCodeStyle}>{`${pack.packsRoot}/${projectSlug}/spec.md`}</code> exists.
          <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Link className="btn btn--accent" href={uploadHref}>
              + Upload pack
            </Link>
            <Link className="btn btn--ghost" href="/init">
              Bootstrap from template
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div className="dash-list" style={{ marginTop: 12 }}>
            {pack.chain.map((row) => (
              <PackChainRow key={row.slug} row={row} role="ancestor" />
            ))}
            <PackChainRow row={pack.primary} role="primary" />
          </div>

          <div style={{ marginTop: 18, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Link className="btn btn--accent" href={uploadHref}>
              + Upload pack
            </Link>
            <Link className="btn btn--ghost" href={`/packs/${encodeURIComponent(projectSlug)}`}>
              Open primary
            </Link>
            <details style={{ position: 'relative' }}>
              <summary className="btn btn--sm btn--ghost" style={{ listStyle: 'none', cursor: 'pointer' }}>
                Install a template…
              </summary>
              <form
                action={installTemplateAction}
                style={{
                  marginTop: 12,
                  padding: 18,
                  border: '1px solid var(--rule)',
                  background: 'var(--bg-2)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  minWidth: 320,
                }}
              >
                <input type="hidden" name="projectSlug" value={projectSlug} />
                <input type="hidden" name="packSlug" value={projectSlug} />
                <input type="hidden" name="cwd" value={cwd} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <label style={packLabelStyle}>Template</label>
                <select name="templateName" required style={packInputStyle} defaultValue="">
                  <option value="">— pick a template —</option>
                  {templates.map((t) => (
                    <option key={`${t.source}:${t.name}`} value={t.name}>
                      {t.source} · {t.name}
                    </option>
                  ))}
                </select>
                <label style={packLabelStyle}>
                  Confirmation (type <code style={packCodeStyle}>install &lt;template&gt;</code>)
                </label>
                <input name="confirmation" required placeholder="install <template>" style={packInputStyle} />
                <button className="btn btn--sm" type="submit">
                  Overlay template
                </button>
                <p style={{ ...packHintStyle, marginTop: 0 }}>
                  Re-renders <code style={packCodeStyle}>spec.md</code> /{' '}
                  <code style={packCodeStyle}>implementation.md</code> / <code style={packCodeStyle}>techstack.md</code>{' '}
                  auto-marker sections. User-edited content outside markers is preserved.
                </p>
              </form>
            </details>
            <span style={{ marginLeft: 'auto', ...packHintStyle, marginTop: 0 }}>
              parent chain · {pack.chain.length} · resolved root-first by MCP
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function PackChainRow({
  row,
  role,
}: {
  readonly row: {
    readonly slug: string;
    readonly fileCount: number;
    readonly parentSlug: string | null;
    readonly isActive: boolean;
  };
  readonly role: 'primary' | 'ancestor';
}) {
  const status =
    row.fileCount === 4
      ? { label: 'SYNCED', cls: 'badge--ok' }
      : row.fileCount === 0
        ? { label: 'EMPTY', cls: 'badge--warn' }
        : { label: `${row.fileCount}/4`, cls: 'badge--caution' };
  const dotCls = role === 'primary' ? '' : 'row__dot--w';
  const eyebrow =
    role === 'primary'
      ? 'PRIMARY · auto-injected'
      : `ANCESTOR · ${row.parentSlug !== null ? `→ ${row.parentSlug}` : 'root'}`;
  return (
    <Link
      href={`/packs/${encodeURIComponent(row.slug)}`}
      className="row"
      style={{ display: 'grid', textDecoration: 'none' }}
    >
      <div className={`row__dot ${dotCls}`}></div>
      <div className="row__main">
        <div className="row__title">
          <em>{row.slug}</em>
          {row.parentSlug !== null && role === 'primary' ? (
            <span style={{ marginLeft: 8, color: 'var(--ink-mute)', fontFamily: 'var(--mono)', fontSize: 11 }}>
              · child of {row.parentSlug}
            </span>
          ) : null}
        </div>
        <div className="row__sub">{eyebrow}</div>
      </div>
      <div className="row__verdict">
        <span className={`badge ${status.cls}`}>
          <span className="badge__dot"></span>
          {status.label}
        </span>
      </div>
      <div className="row__time">{row.isActive ? 'active' : 'inactive'}</div>
    </Link>
  );
}

const packCodeStyle: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.92em',
  color: 'var(--accent)',
};

const packLabelStyle: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 9,
  letterSpacing: '0.2em',
  textTransform: 'uppercase',
  color: 'var(--ink-mute)',
};

const packInputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--bg)',
  border: '1px solid var(--rule-strong)',
  color: 'var(--ink)',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  letterSpacing: '0.04em',
};

const packHintStyle: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  color: 'var(--ink-mute)',
  letterSpacing: '0.04em',
  marginTop: 6,
  lineHeight: 1.6,
};

/** Single-line truncation used by the project-home features panel. */
function truncate(s: string, max: number): string {
  const oneline = s.replace(/\s+/g, ' ').trim();
  if (oneline.length <= max) return oneline;
  return `${oneline.slice(0, max - 1)}…`;
}
