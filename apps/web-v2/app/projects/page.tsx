import Link from 'next/link';

import { Topbar } from '@/components/Topbar';
import { resolveDeploymentMode } from '@/lib/deployment-mode';
import { fmtRelative } from '@/lib/format';
import { fetchPickerSnapshot } from '@/lib/queries/picker';

export const dynamic = 'force-dynamic';

export default async function ProjectsHubPage() {
  const snap = await fetchPickerSnapshot();
  const totalActive = snap.projects.reduce((acc, p) => acc + p.activeRuns, 0);
  const totalDenials = snap.projects.reduce((acc, p) => acc + p.denials24h, 0);
  const totalSwitches = snap.projects.reduce((acc, p) => acc + p.activeKillSwitches, 0);
  // In team-hosted mode the "New project" button leads to /init which
  // returns 404 (init is a local-laptop operation). Hide the button
  // and replace the empty-state CTA with the CLI instruction.
  const isTeamHosted = resolveDeploymentMode() === 'team-hosted';

  return (
    <>
      <Topbar crumb="Projects" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/01 · WORKSPACE · PROJECTS</div>
            <h1 className="head__title">
              Every <em>project</em>, one shelf.
            </h1>
            <p className="head__lede">
              {isTeamHosted ? (
                <>
                  Each card is a registered project from any teammate's local{' '}
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--ink)' }}>coodra init</span> — synced
                  to your cloud Postgres.
                </>
              ) : (
                <>
                  Each card is a registered project under{' '}
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--ink)' }}>~/.coodra</span>.
                </>
              )}{' '}
              Status dot reflects last 24h: <span style={{ color: 'var(--warn)' }}>red</span> for denials,{' '}
              <span style={{ color: 'var(--caution)' }}>amber</span> for active kill switches,{' '}
              <span style={{ color: 'var(--accent)' }}>green</span> for live runs.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>{snap.projects.length} projects</strong>
              <br />
              {totalActive} runs · {totalDenials} denies · {totalSwitches} switches
              <br />
              fetched · {fmtRelative(snap.fetchedAt)}
            </div>
            {isTeamHosted ? null : (
              <div className="head__actions">
                <Link className="btn btn--accent" href="/init">
                  New project
                </Link>
              </div>
            )}
          </div>
        </div>

        {snap.projects.length === 0 ? (
          <div className="empty">
            <strong>
              No projects <em>yet</em>.
            </strong>
            {isTeamHosted ? (
              <>
                {' '}Projects are registered by developers running{' '}
                <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>coodra init</span> on their
                local laptops. Once a teammate runs it against a repo and that repo's first agent session fires,
                a project card appears here.
              </>
            ) : (
              <>
                {' '}Run <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>coodra init</span>{' '}
                in any repo — or click{' '}
                <Link href="/init" style={{ color: 'var(--accent)' }}>
                  New project
                </Link>{' '}
                above — to register one.
              </>
            )}
          </div>
        ) : (
          <div className="pack-grid">
            {snap.projects.map((p) => {
              const dotColor =
                p.statusDot === 'red'
                  ? 'var(--warn)'
                  : p.statusDot === 'amber'
                    ? 'var(--caution)'
                    : p.statusDot === 'green'
                      ? 'var(--accent)'
                      : 'var(--ink-mute)';
              const statusLabel =
                p.statusDot === 'red'
                  ? 'ALERT'
                  : p.statusDot === 'amber'
                    ? 'PAUSED'
                    : p.statusDot === 'green'
                      ? 'LIVE'
                      : 'IDLE';
              const denialClass = p.denials24h > 0 ? 'project-card__metric-value--warn' : '';
              const switchClass = p.activeKillSwitches > 0 ? 'project-card__metric-value--caution' : '';
              return (
                <Link
                  key={p.id}
                  href={`/projects/${encodeURIComponent(p.slug)}`}
                  className="project-card"
                  style={{ textDecoration: 'none' }}
                >
                  <div className="project-card__head">
                    <span className="project-card__slug">
                      <span
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          background: dotColor,
                          boxShadow: p.statusDot === 'green' ? '0 0 6px var(--accent-glow)' : 'none',
                        }}
                      ></span>
                      {p.slug}
                    </span>
                    <span
                      className="badge"
                      style={
                        p.statusDot === 'green'
                          ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                          : p.statusDot === 'red'
                            ? { borderColor: 'var(--warn)', color: 'var(--warn)' }
                            : p.statusDot === 'amber'
                              ? { borderColor: 'var(--caution)', color: 'var(--caution)' }
                              : undefined
                      }
                    >
                      <span className="badge__dot"></span>
                      {statusLabel}
                    </span>
                  </div>

                  <h3 className="project-card__title">
                    <em>{p.name}</em>
                  </h3>

                  <div className="project-card__metrics">
                    <div className="project-card__metric">
                      <span className="project-card__metric-label">Runs</span>
                      <span className="project-card__metric-value">
                        {p.activeRuns === 0 ? <em>0</em> : p.activeRuns}
                      </span>
                    </div>
                    <div className="project-card__metric">
                      <span className="project-card__metric-label">Denies · 24h</span>
                      <span className={`project-card__metric-value ${denialClass}`}>{p.denials24h}</span>
                    </div>
                    <div className="project-card__metric">
                      <span className="project-card__metric-label">Switches</span>
                      <span className={`project-card__metric-value ${switchClass}`}>{p.activeKillSwitches}</span>
                    </div>
                  </div>

                  <div className="project-card__foot">
                    <span>
                      {p.id.slice(0, 8)} ·{' '}
                      {p.lastActivityAt === null ? 'idle' : `last ${fmtRelative(p.lastActivityAt)}`}
                    </span>
                    <span className="project-card__foot-link">OPEN →</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
