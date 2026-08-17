import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { deleteProjectAction, renameProjectAction, resetProjectAction } from '@/lib/actions/projects';
import { cancelAllInProgressRunsAction } from '@/lib/actions/runs';
import { agentTypeLabel } from '@/lib/agent-label';
import { fmtClockSec, fmtRelative } from '@/lib/format';
import { resolveProjectFromParams } from '@/lib/project-context';
import { fetchProjectFeaturesSnapshot } from '@/lib/queries/features';
import { fetchProjectHomeSnapshot } from '@/lib/queries/project-home';
import { listRuns } from '@/lib/queries/runs';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly reset?: string;
  readonly summary?: string;
  readonly renamed?: string;
  readonly error?: string;
  readonly errorMessage?: string;
  readonly cleared?: string;
  readonly linked?: string;
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
  const cwd = project.cwd ?? process.cwd();
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
                Skills
              </Link>
              <Link className="btn btn--ghost" href={`/runs?project=${encodeURIComponent(project.slug)}`}>
                Open runs
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
        {sp.linked === '1' ? <Banner tone="ok">Linked current run to {project.slug}.</Banner> : null}
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
                          {agentTypeLabel(run.agentType)} · <em>{run.sessionId.slice(0, 12)}</em>
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

        <WorkPackPanel projectSlug={project.slug} total={snap.workPacks.total} active={snap.workPacks.active} />

        {/* Features panel — skill-style index. Empty state surfaces the
            "Define your first feature" CTA so onboarding from a fresh
            project lands here, not buried in /features. */}
        <div className="card" style={{ padding: 28, marginTop: 32 }}>
          <div className="card__head">
            <h2 className="card__title">
              <em>Skills</em>
            </h2>
            <span className="card__role">
              {featuresSnap.features.length} skill{featuresSnap.features.length === 1 ? '' : 's'} ·{' '}
              <span style={{ color: 'var(--ink-dim)' }}>{featuresSnap.featuresRoot}</span>
            </span>
          </div>

          {featuresSnap.features.length === 0 ? (
            <div className="empty" style={{ marginTop: 12 }}>
              <strong>
                No <em>skills</em> yet.
              </strong>
              Define a skill for each meaningful slice of this project — auth, billing, the import pipeline. Drop in any
              md / spec / code samples that help an agent understand it. We index the triggers; the agent picks what to
              load.
              <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <Link className="btn btn--accent" href={`/projects/${encodeURIComponent(project.slug)}/features/new`}>
                  + Define your first skill
                </Link>
                <Link className="btn btn--ghost" href={`/projects/${encodeURIComponent(project.slug)}/features`}>
                  Open skills panel
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
                          <span
                            style={{ marginLeft: 8, color: 'var(--ink-mute)', fontFamily: 'var(--mono)', fontSize: 11 }}
                          >
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
                <Link className="btn btn--accent" href={`/projects/${encodeURIComponent(project.slug)}/features/new`}>
                  + Add recipe
                </Link>
                <Link className="btn btn--ghost" href={`/projects/${encodeURIComponent(project.slug)}/features`}>
                  Open skills panel
                </Link>
                {featuresSnap.features.length > 6 ? (
                  <span
                    style={{
                      marginLeft: 'auto',
                      alignSelf: 'center',
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                      color: 'var(--ink-mute)',
                    }}
                  >
                    showing 6 of {featuresSnap.features.length}
                  </span>
                ) : null}
              </div>
            </>
          )}
        </div>

        {/* Admin: rename · reset · delete (skipped on __global__ sentinel) */}
        {!isSentinel ? (
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
  const inputId = `project-field-${name}`;
  return (
    <div style={{ marginBottom: 12 }}>
      <label
        htmlFor={inputId}
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
        id={inputId}
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

function WorkPackPanel({
  projectSlug,
  total,
  active,
}: {
  readonly projectSlug: string;
  readonly total: number;
  readonly active: number;
}) {
  return (
    <div className="card" style={{ padding: 28, marginTop: 32 }}>
      <div className="card__head">
        <h2 className="card__title">
          Work <em>Packs</em>
        </h2>
        <span className="card__role">
          {total} total · {active} active
        </span>
      </div>
      {total === 0 ? (
        <div className="empty" style={{ marginTop: 12 }}>
          <strong>
            No Work Packs <em>yet</em>.
          </strong>
          Import a Jira epic, task, or story into <span style={{ fontFamily: 'var(--mono)' }}>.coodra/work-packs/</span>{' '}
          so the agent has an issue-bound implementation record for this project.
          <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Link className="btn btn--accent" href="/work-packs">
              Open Work Packs
            </Link>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 18, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Link className="btn btn--accent" href="/work-packs">
            Open Work Packs
          </Link>
          <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-mute)' }}>
            project · {projectSlug}
          </span>
        </div>
      )}
    </div>
  );
}

/** Single-line truncation used by the project-home features panel. */
function truncate(s: string, max: number): string {
  const oneline = s.replace(/\s+/g, ' ').trim();
  if (oneline.length <= max) return oneline;
  return `${oneline.slice(0, max - 1)}…`;
}
