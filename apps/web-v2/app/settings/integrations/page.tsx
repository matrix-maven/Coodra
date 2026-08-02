import { Topbar } from '@/components/Topbar';

export const dynamic = 'force-dynamic';

/**
 * `/settings/integrations` — Module 09, Track 9B.
 *
 * Historically this page wired external MCP servers (Graphify, and
 * before that Jira/Rovo) into agent configs via server actions. Both
 * explicit wiring paths are retired: Graphify is Coodra-owned end to
 * end — `coodra agent add <agent>` installs the native Claude Code /
 * Codex plugin, which bundles a managed `graphify` MCP entry
 * automatically, machine-wide. There is nothing left to enable/disable
 * per project, so this page is now a pointer to the CLI's read-only
 * status surface rather than a write surface.
 */
export default function IntegrationsPage() {
  return (
    <>
      <Topbar crumb="Integrations" crumbPrefix="coodra / settings" />
      <section className="screen">
        <div className="head">
          <div>
            <div className="head__num">/07 · EXTERNAL MCP · INTEGRATIONS</div>
            <h1 className="head__title">
              Graphify is <em>Coodra-managed</em>, machine-wide.
            </h1>
            <p className="head__lede">
              Coodra consumes external MCP servers by configuration, not code. Graphify (
              <code style={inlineMono}>safishamsi/graphify</code>) ships its own stdio MCP server exposing structural
              queries — blast radius, “where is X defined?”, dependency paths — and there is no separate wiring step
              anymore.
            </p>
          </div>
        </div>

        <div className="card" style={{ padding: 36, marginTop: 8 }}>
          <h2 className="card__title" style={{ marginBottom: 14 }}>
            Graphify
          </h2>
          <p style={{ fontSize: 14, color: 'var(--ink-dim)', lineHeight: 1.6, marginBottom: 20 }}>
            <code style={inlineMono}>coodra install</code> sets up one shared machine runtime at{' '}
            <code style={inlineMono}>~/.coodra/graphify-mcp/.venv</code>. Every native Claude Code / Codex plugin
            install (<code style={inlineMono}>coodra agent add &lt;agent&gt;</code>) bundles a managed{' '}
            <code style={inlineMono}>graphify</code> MCP entry alongside <code style={inlineMono}>coodra</code>, pointed
            at that runtime and at each project&apos;s <code style={inlineMono}>.coodra/graphify/out/graph.json</code>.
            There is no manual config-file wiring path left — installing the agent plugin is the whole story.
          </p>
          <CmdBlock>{`coodra agent add claude      # or codex — installs the plugin, bundles Graphify
coodra graphify status       # check wiring + graph artifacts, read-only
coodra graphify build        # build/refresh the graph
coodra graphify open         # open the interactive graph.html`}</CmdBlock>
        </div>
      </section>
    </>
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
        marginTop: 20,
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
