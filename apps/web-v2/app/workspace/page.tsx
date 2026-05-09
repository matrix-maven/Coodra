import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { Topbar } from '@/components/Topbar';
import { refreshStatusAction, startServicesAction, stopServicesAction } from '@/lib/actions/services';
import { listProjects } from '@/lib/queries/projects';

export const dynamic = 'force-dynamic';

interface SearchParams {
  readonly started?: string;
  readonly stopped?: string;
  readonly refreshed?: string;
  readonly error?: string;
  readonly errorMessage?: string;
}

interface ServiceRow {
  readonly key: 'mcp-server' | 'hooks-bridge' | 'sync-daemon';
  readonly name: string;
  readonly addr: string;
  readonly status: 'reachable' | 'unreachable' | 'idle';
  readonly note: string;
}

async function probe(url: string, timeoutMs = 600): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

export default async function WorkspacePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const mode = (process.env.CONTEXTOS_MODE ?? 'solo') as 'solo' | 'team';
  const isSolo = mode === 'solo';
  const home = process.env.CONTEXTOS_HOME ?? resolve(homedir(), '.contextos');
  const dbPath = resolve(home, 'data.db');
  const dbExists = existsSync(dbPath);
  const dbSize = dbExists ? statSync(dbPath).size : 0;

  const mcpPort = process.env.MCP_SERVER_PORT ?? '3100';
  const bridgePort = process.env.HOOKS_BRIDGE_PORT ?? '3101';

  const [mcpOk, bridgeOk, projects] = await Promise.all([
    probe(`http://127.0.0.1:${mcpPort}/healthz`),
    probe(`http://127.0.0.1:${bridgePort}/healthz`),
    listProjects(),
  ]);

  const services: ReadonlyArray<ServiceRow> = [
    {
      key: 'mcp-server',
      name: 'MCP server',
      addr: `127.0.0.1:${mcpPort} · stdio + http`,
      status: mcpOk ? 'reachable' : 'unreachable',
      note: mcpOk ? 'health check OK' : 'no response',
    },
    {
      key: 'hooks-bridge',
      name: 'Hooks bridge',
      addr: `127.0.0.1:${bridgePort} · http · 4 handlers`,
      status: bridgeOk ? 'reachable' : 'unreachable',
      note: bridgeOk ? 'health check OK' : 'no response',
    },
    {
      key: 'sync-daemon',
      name: 'Sync daemon',
      addr: mode === 'team' ? 'cloud postgres queue worker' : 'standby · solo',
      status: mode === 'team' ? 'reachable' : 'idle',
      note: mode === 'team' ? 'team mode' : 'no team config',
    },
  ];

  return (
    <>
      <Topbar crumb="Workspace" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/05 · SYSTEM · WORKSPACE</div>
            <h1 className="head__title">
              Local <em>services</em>.
            </h1>
            <p className="head__lede">
              All ContextOS daemons running on this machine. Health-probed live; solo mode runs MCP + Hooks; team mode
              adds Sync.
            </p>
          </div>
          <div>
            <div className="head__meta">
              <strong>
                {services.filter((s) => s.status === 'reachable').length}/{services.length} healthy
              </strong>
              <br />
              {projects.length} projects loaded
              <br />
              mode · {mode}
            </div>
            <div className="head__actions">
              {isSolo ? (
                <>
                  <form action={refreshStatusAction} style={{ display: 'inline' }}>
                    <button className="btn btn--ghost" type="submit">
                      Refresh
                    </button>
                  </form>
                  <form action={startServicesAction} style={{ display: 'inline' }}>
                    <button className="btn btn--accent" type="submit">
                      Start all
                    </button>
                  </form>
                </>
              ) : (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-mute)' }}>
                  team mode · remote-managed
                </span>
              )}
            </div>
          </div>
        </div>

        {sp.started !== undefined ? <Banner tone="ok">Services started · processes spawned.</Banner> : null}
        {sp.stopped !== undefined ? <Banner tone="ok">Services stopped.</Banner> : null}
        {sp.refreshed !== undefined ? <Banner tone="ok">Status refreshed.</Banner> : null}
        {sp.error !== undefined ? <Banner tone="warn">{sp.errorMessage ?? sp.error}</Banner> : null}

        {!isSolo ? (
          <div className="empty" style={{ marginBottom: 24 }}>
            <strong>
              Team mode · <em>remote</em>
            </strong>
            Service start/stop is solo-mode only. In team mode the daemons run on the deployment platform.
          </div>
        ) : null}

        <div style={{ marginBottom: 8 }}>
          {services.map((svc) => {
            const tone = svc.status === 'reachable' ? 'badge--ok' : svc.status === 'idle' ? '' : 'badge--warn';
            const canControl = isSolo && svc.key !== 'sync-daemon';
            return (
              <div key={svc.name} className="svc-row" style={svcRow}>
                <div>
                  <div style={{ fontFamily: 'var(--serif)', fontSize: 22 }}>
                    {svc.name.split(' ')[0]} <em>{svc.name.split(' ').slice(1).join(' ')}</em>
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 11,
                      color: 'var(--ink-dim)',
                      marginTop: 4,
                      letterSpacing: '0.04em',
                    }}
                  >
                    {svc.addr}
                  </div>
                </div>
                <div>
                  <span className={`badge ${tone}`}>
                    <span className="badge__dot"></span>
                    {svc.status.toUpperCase()}
                  </span>
                </div>
                <div
                  style={{
                    fontFamily: 'var(--mono)',
                    fontSize: 11,
                    color: 'var(--ink-dim)',
                    letterSpacing: '0.04em',
                  }}
                >
                  {svc.note}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {canControl ? (
                    <>
                      {svc.status === 'reachable' ? (
                        <form action={stopServicesAction} style={{ display: 'inline' }}>
                          <input type="hidden" name="service" value={svc.key} />
                          <button className="btn btn--sm btn--ghost" type="submit">
                            Stop
                          </button>
                        </form>
                      ) : (
                        <form action={startServicesAction} style={{ display: 'inline' }}>
                          <input type="hidden" name="only" value={svc.key === 'mcp-server' ? 'mcp' : 'hooks'} />
                          <button className="btn btn--sm" type="submit">
                            Start
                          </button>
                        </form>
                      )}
                    </>
                  ) : (
                    <span style={{ color: 'var(--ink-mute)', fontFamily: 'var(--mono)', fontSize: 10 }}>—</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="dash-grid" style={{ marginTop: 32 }}>
          <div className="aside-card">
            <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
              Storage
            </h3>
            <KV k={`${home}/data.db`} v={dbExists ? `${(dbSize / (1024 * 1024)).toFixed(2)} MB` : 'absent'} />
            <KV k={`${home}/packs/`} v={existsSync(resolve(home, 'packs')) ? 'present' : 'absent'} />
            <KV k={`${home}/logs/`} v={existsSync(resolve(home, 'logs')) ? 'present' : 'absent'} />
            <KV k={`${home}/templates/`} v={existsSync(resolve(home, 'templates')) ? 'present' : 'absent'} />
          </div>
          <div className="aside-card">
            <h3 className="aside-card__title" style={{ marginBottom: 14 }}>
              Projects · <em>loaded</em>
            </h3>
            {projects.length === 0 ? (
              <div style={{ fontSize: 13, color: 'var(--ink-dim)' }}>None.</div>
            ) : (
              projects.map((p) => <KV key={p.id} k={p.slug} v={p.id.slice(0, 8)} />)
            )}
          </div>
        </div>
      </section>
    </>
  );
}

const svcRow: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 200px 200px 140px',
  gap: 24,
  alignItems: 'center',
  padding: '22px 24px',
  border: '1px solid var(--rule)',
  background: 'var(--bg-2)',
  marginBottom: 6,
};

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

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        fontFamily: 'var(--mono)',
        fontSize: 11,
        color: 'var(--ink-dim)',
        padding: '10px 0',
        borderBottom: '1px solid var(--rule)',
        gap: 16,
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{k}</span>
      <span style={{ color: 'var(--ink)', flexShrink: 0 }}>{v}</span>
    </div>
  );
}
