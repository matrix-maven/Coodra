import { Topbar } from '@/components/Topbar';
import { disableGraphifyAction, enableGraphifyAction } from '@/lib/actions/integrations';
import {
  type GraphifyIntegrationStatus,
  type GraphifyProjectStatus,
  readGraphifyIntegrationStatus,
} from '@/lib/queries/integrations';

export const dynamic = 'force-dynamic';

/**
 * `/settings/integrations` — Module 09, Track 9B (phase G4).
 *
 * One card per external-MCP integration. Today that is Graphify. Each
 * card wires an external MCP server into the agent configs alongside
 * the `coodra` server — Coodra consumes these tools by configuration,
 * not code (ADR-010, Option C).
 *
 * Mode behaviour (mirrors `lib/actions/services.ts`):
 *   - local web   — the server actions write `.mcp.json` etc. directly.
 *   - team-hosted — the deployed server has no developer configs to
 *                   write; the card renders the `coodra graphify
 *                   enable` CLI command for each developer to run.
 */

interface SearchParams {
  readonly enabled?: string;
  readonly disabled?: string;
  readonly error?: string;
  readonly errorMessage?: string;
}

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const status = await readGraphifyIntegrationStatus();

  return (
    <>
      <Topbar crumb="Integrations" crumbPrefix="coodra / settings" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/07 · EXTERNAL MCP · INTEGRATIONS</div>
            <h1 className="head__title">
              Wire the tools your agents <em>already trust</em>.
            </h1>
            <p className="head__lede">
              Coodra consumes external MCP servers by configuration, not code. Each card wires one integration into your
              agent configs next to the <code style={inlineMono}>coodra</code> server — nothing is rebuilt, nothing is
              proxied.
            </p>
          </div>
        </div>

        {sp.enabled !== undefined ? (
          <Banner tone="ok">
            ● Graphify wired for project “{sp.enabled}”. Restart the agent so it re-reads its MCP config.
          </Banner>
        ) : null}
        {sp.disabled !== undefined ? <Banner tone="ok">● Graphify unwired for project “{sp.disabled}”.</Banner> : null}
        {sp.error !== undefined ? <Banner tone="warn">✕ {sp.errorMessage ?? sp.error}</Banner> : null}

        <GraphifyCard status={status} />
      </section>
    </>
  );
}

/* ---------- Graphify card ---------- */

function GraphifyCard({ status }: { readonly status: GraphifyIntegrationStatus }) {
  return (
    <div className="card" style={{ padding: 36, marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16 }}>
        <h2 className="card__title" style={{ marginBottom: 6 }}>
          Graphify
        </h2>
        <span style={tagStyle}>codebase knowledge graph</span>
      </div>
      <p style={{ fontSize: 14, color: 'var(--ink-dim)', lineHeight: 1.6, marginBottom: 24 }}>
        Graphify (<code style={inlineMono}>safishamsi/graphify</code>) maps a repository into a queryable knowledge
        graph and ships its own stdio MCP server. Coodra wires that server into your agent configs so the agent can ask
        structural questions — blast radius, “where is X defined?”, dependency paths. The agent calls Graphify’s query
        tools directly; Coodra does not mint Work Packs from the graph.
      </p>

      <SectionLabel>Prerequisites</SectionLabel>
      <ol style={prereqList}>
        <li>
          Install Graphify with its MCP extra: <code style={inlineMono}>pip install &quot;graphifyy[mcp]&quot;</code>{' '}
          (or an isolated venv — Graphify’s recommendation).
        </li>
        <li>
          Build the graph so <code style={inlineMono}>graphify-out/graph.json</code> exists — run{' '}
          <code style={inlineMono}>/graphify .</code> in your AI assistant (install:{' '}
          <code style={inlineMono}>uv tool install graphifyy</code>).
        </li>
      </ol>

      {status.cloudHosted ? <TeamHostedBody /> : <LocalBody status={status} />}
    </div>
  );
}

/** team-hosted web — the server can't touch developer configs; show the CLI command. */
function TeamHostedBody() {
  return (
    <div style={{ marginTop: 28 }}>
      <SectionLabel>Enable Graphify</SectionLabel>
      <p style={bodyText}>
        This web app is team-hosted — it has no access to each developer’s local agent configs. Every developer wires
        Graphify on their own machine, from inside the project they want graphed:
      </p>
      <CmdBlock>coodra graphify enable</CmdBlock>
      <p style={{ ...bodyText, marginTop: 16 }}>
        That command wires the <code style={inlineMono}>graphify</code> MCP server into every detected agent config.{' '}
        <code style={inlineMono}>coodra graphify status</code> shows the wiring;{' '}
        <code style={inlineMono}>coodra graphify disable</code> removes it.
      </p>
    </div>
  );
}

/** local web — wire the configs directly via server actions, per project. */
function LocalBody({ status }: { readonly status: GraphifyIntegrationStatus }) {
  const detectedCount = status.detectedAgents.length;
  return (
    <div style={{ marginTop: 28 }}>
      <SectionLabel>Projects</SectionLabel>
      {detectedCount === 0 ? (
        <Banner tone="warn">
          ✕ No supported IDE (Claude Code, Codex) detected on this machine. Install one, then reload.
        </Banner>
      ) : (
        <p style={bodyText}>
          Detected agents on this machine:{' '}
          <strong style={{ color: 'var(--ink)' }}>{status.detectedAgents.join(', ')}</strong>. “Enable” wires Graphify
          into each of them for the chosen project.
        </p>
      )}

      {status.projects.length === 0 ? (
        <Banner tone="muted">
          No projects registered yet. Run <code style={inlineMono}>coodra init</code> in a project, then reload.
        </Banner>
      ) : (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--rule)' }}>
          {status.projects.map((project) => (
            <ProjectRow key={project.slug} project={project} detectedCount={detectedCount} />
          ))}
        </div>
      )}

      <p style={{ ...bodyText, marginTop: 22, fontSize: 12, color: 'var(--ink-mute)' }}>
        The wiring is idempotent and never clobbers a hand-edited entry; use{' '}
        <code style={inlineMono}>coodra graphify enable --force</code> from the CLI to overwrite a drifted one.
      </p>
    </div>
  );
}

function ProjectRow({
  project,
  detectedCount,
}: {
  readonly project: GraphifyProjectStatus;
  readonly detectedCount: number;
}) {
  const noCwd = project.cwd === null;
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 16,
        padding: '16px 0',
        borderBottom: '1px solid var(--rule)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, color: 'var(--ink)' }}>{project.name}</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-mute)', marginTop: 3 }}>
          {project.slug}
          {noCwd ? ' · cwd not recorded' : ''}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <WiredBadge wiredCount={project.wiredCount} detectedCount={detectedCount} noCwd={noCwd} />
        {noCwd ? (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--ink-mute)' }}>run `coodra init`</span>
        ) : (
          <>
            <form action={enableGraphifyAction}>
              <input type="hidden" name="projectSlug" value={project.slug} />
              <input type="hidden" name="cwd" value={project.cwd ?? ''} />
              <button type="submit" className="btn btn--accent" disabled={detectedCount === 0}>
                {project.wiredCount > 0 ? 'Re-sync' : 'Enable'}
              </button>
            </form>
            <form action={disableGraphifyAction}>
              <input type="hidden" name="projectSlug" value={project.slug} />
              <input type="hidden" name="cwd" value={project.cwd ?? ''} />
              <button type="submit" className="btn btn--ghost" disabled={project.wiredCount === 0}>
                Disable
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function WiredBadge({
  wiredCount,
  detectedCount,
  noCwd,
}: {
  readonly wiredCount: number;
  readonly detectedCount: number;
  readonly noCwd: boolean;
}) {
  if (noCwd) {
    return <span className="badge">unknown</span>;
  }
  if (wiredCount === 0) {
    return <span className="badge">not wired</span>;
  }
  if (wiredCount >= detectedCount && detectedCount > 0) {
    return (
      <span className="badge badge--ok">
        <span className="badge__dot" />
        wired
      </span>
    );
  }
  return (
    <span className="badge">
      {wiredCount}/{detectedCount} agents
    </span>
  );
}

/* ---------- shared atoms ---------- */

function Banner({ tone, children }: { readonly tone: 'ok' | 'warn' | 'muted'; readonly children: React.ReactNode }) {
  const color = tone === 'ok' ? 'var(--accent)' : tone === 'warn' ? 'var(--warn)' : 'var(--ink-mute)';
  return (
    <div
      style={{
        border: `1px solid ${color}`,
        background: tone === 'ok' ? 'var(--accent-glow)' : 'transparent',
        color: 'var(--ink-dim)',
        padding: '14px 18px',
        fontSize: 13,
        lineHeight: 1.55,
        marginBottom: 16,
      }}
    >
      {children}
    </div>
  );
}

function SectionLabel({ children }: { readonly children: React.ReactNode }) {
  return (
    <div
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 10,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: 'var(--ink-mute)',
        marginBottom: 12,
      }}
    >
      {children}
    </div>
  );
}

function CmdBlock({ children }: { readonly children: React.ReactNode }) {
  return (
    <pre
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 12,
        color: 'var(--ink)',
        background: 'var(--bg)',
        border: '1px solid var(--rule-strong)',
        padding: 18,
        margin: 0,
        overflowX: 'auto',
      }}
    >
      {children}
    </pre>
  );
}

const inlineMono: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: '0.85em',
  color: 'var(--ink)',
};

const bodyText: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--ink-dim)',
  lineHeight: 1.6,
};

const prereqList: React.CSSProperties = {
  margin: 0,
  paddingLeft: 20,
  fontSize: 13,
  color: 'var(--ink-dim)',
  lineHeight: 1.7,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const tagStyle: React.CSSProperties = {
  fontFamily: 'var(--mono)',
  fontSize: 10,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--ink-mute)',
  flexShrink: 0,
};
