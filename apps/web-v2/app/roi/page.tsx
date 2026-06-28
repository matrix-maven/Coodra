import {
  buildMethodology,
  computeRoiBand,
  DEFAULT_ROI_CONSTANTS,
  type MethodologyRow,
  ROI_SOURCES,
  type RoiResult,
} from '@coodra/shared/roi';
import { Topbar } from '@/components/Topbar';
import { resolveDeploymentMode } from '@/lib/deployment-mode';
import { fetchRoiSnapshot, type RoiNamedCount, type RoiSnapshot, type RoiTrendPoint } from '@/lib/queries/roi';

export const dynamic = 'force-dynamic';

/**
 * `/roi` — the ROI / value dashboard. Proves operational value across four
 * dimensions (Adoption → Governance → Knowledge → Impact), then exposes the
 * raw counts and the modeling assumptions so every derived dollar is
 * auditable. MEASURED numbers are plain; MODELED numbers carry a chip and a
 * methodology row (Forrester-TEI / Tufte / KCS-grounded — see
 * docs/coodra-roi-and-metrics-architecture.md).
 */
export default async function RoiPage() {
  const snap = await fetchRoiSnapshot();
  const band = computeRoiBand(snap.modeledInputs, DEFAULT_ROI_CONSTANTS);
  const methodology = buildMethodology(snap.modeledInputs, DEFAULT_ROI_CONSTANTS, band.base);
  const dm = resolveDeploymentMode();

  return (
    <>
      <Topbar crumb="ROI" crumbPrefix={snap.mode === 'team' ? 'coodra · team' : 'coodra · solo'} />
      <section className="screen">
        <Header snap={snap} base={band.base} />
        <Legend />
        <Hero base={band.base} conservative={band.conservative} optimistic={band.optimistic} snap={snap} />
        <LeadingRow snap={snap} />
        <AdoptionSection snap={snap} />
        <GovernanceSection snap={snap} />
        <KnowledgeSection snap={snap} />
        <ImpactSection base={band.base} conservative={band.conservative} optimistic={band.optimistic} snap={snap} />
        <EvidenceSection methodology={methodology} />
        <AssumptionsSection isTeamHosted={dm === 'team-hosted'} />
      </section>
    </>
  );
}

/* ───────────────────────── formatting ───────────────────────── */

const fmtInt = (n: number): string => Math.round(n).toLocaleString();
// Formatting MUST match the CLI's fmtUsd (packages/cli/src/commands/metrics.ts)
// exactly so the same computed value renders identically on both surfaces:
// k-notation at ≥$1000, cents below. fmtUsdK is kept as an alias for the call
// sites that intend the "k for large" headline form (now identical behaviour).
const fmtUsd = (n: number): string => (Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(2)}`);
const fmtUsdK = (n: number): string => fmtUsd(n);
const fmtPct = (n: number | null, digits = 0): string => (n === null ? '—' : `${n.toFixed(digits)}%`);
const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : `${Math.round(n)}`;
const fmtRatio = (n: number | null): string => (n === null ? '—' : `${n.toFixed(1)}×`);
const toolShort = (t: string): string => t.replace(/^coodra__/, '');

/* ───────────────────────── primitives ───────────────────────── */

function Chip({ kind }: { kind: 'measured' | 'modeled' }) {
  const measured = kind === 'measured';
  return (
    <span
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 8,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: measured ? 'var(--ink-mute)' : 'var(--caution)',
        border: `1px solid ${measured ? 'var(--rule-strong)' : 'var(--caution)'}`,
        padding: '2px 5px',
        borderRadius: 2,
        whiteSpace: 'nowrap',
      }}
    >
      {measured ? '● measured' : '◐ modeled'}
    </span>
  );
}

/** Dependency-free SVG sparkline from a weekly trend. */
function Sparkline({
  points,
  color = 'var(--accent)',
  width = 132,
  height = 30,
}: {
  points: ReadonlyArray<RoiTrendPoint>;
  color?: string;
  width?: number;
  height?: number;
}) {
  const counts = points.map((p) => p.count);
  const max = Math.max(1, ...counts);
  const n = counts.length;
  if (n === 0) return null;
  const stepX = n > 1 ? width / (n - 1) : 0;
  const y = (c: number) => height - 2 - (c / max) * (height - 4);
  const line = counts.map((c, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(1)},${y(c).toFixed(1)}`).join(' ');
  const area = `${line} L${((n - 1) * stepX).toFixed(1)},${height} L0,${height} Z`;
  const lastX = (n - 1) * stepX;
  const lastY = y(counts[n - 1] ?? 0);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      <path d={area} fill={color} opacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} />
      <circle cx={lastX} cy={lastY} r={2} fill={color} />
    </svg>
  );
}

/** CSS meter bar. */
function Meter({ pct, color = 'var(--accent)' }: { pct: number; color?: string }) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <div style={{ height: 8, background: 'var(--bg-3)', border: '1px solid var(--rule)', overflow: 'hidden' }}>
      <div style={{ width: `${w}%`, height: '100%', background: color }} />
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  tone = 'ink',
  chip,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: 'ink' | 'accent' | 'warn' | 'caution' | 'mute';
  chip?: 'measured' | 'modeled';
}) {
  const color =
    tone === 'accent'
      ? 'var(--accent)'
      : tone === 'warn'
        ? 'var(--warn)'
        : tone === 'caution'
          ? 'var(--caution)'
          : tone === 'mute'
            ? 'var(--ink-mute)'
            : 'var(--ink)';
  return (
    <div className="stat">
      <div
        className="stat__label"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
      >
        <span>{label}</span>
        {chip !== undefined ? <Chip kind={chip} /> : null}
      </div>
      <div className="stat__num" style={{ color }}>
        {value}
      </div>
      {sub !== undefined ? <div className="stat__delta">{sub}</div> : null}
    </div>
  );
}

function SectionHead({
  num,
  title,
  em,
  caption,
  chip,
}: {
  num: string;
  title: string;
  em: string;
  caption: string;
  chip?: 'measured' | 'modeled';
}) {
  return (
    <div className="card__head" style={{ marginTop: 40, marginBottom: 18, alignItems: 'baseline' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.2em', color: 'var(--ink-mute)' }}>
          {num}
        </span>
        <h2 className="card__title">
          {title} <em>{em}</em>
        </h2>
        {chip !== undefined ? <Chip kind={chip} /> : null}
      </div>
      <span className="card__role">{caption}</span>
    </div>
  );
}

/** A labelled horizontal breakdown row (used for token/credit levers). */
function LeverRow({
  label,
  value,
  pct,
  color = 'var(--accent)',
}: {
  label: string;
  value: string;
  pct: number;
  color?: string;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '180px 1fr 90px',
        gap: 14,
        alignItems: 'center',
        padding: '7px 0',
      }}
    >
      <div style={{ fontSize: 13, color: 'var(--ink-dim)' }}>{label}</div>
      <Meter pct={pct} color={color} />
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'right', color: 'var(--ink)' }}>{value}</div>
    </div>
  );
}

/* ───────────────────────── header / legend ───────────────────────── */

function Header({ snap, base }: { snap: RoiSnapshot; base: RoiResult }) {
  return (
    <div className="head">
      <div>
        <div className="head__num">/05 · VALUE · RETURN ON CONTEXT</div>
        <h1 className="head__title">
          The <em>payoff</em>, measured.
        </h1>
        <p className="head__lede">
          Coodra's value across four dimensions — adoption, governance, knowledge capitalization, and modeled
          efficiency. Observed counts are stated plainly; dollar figures are modeled from those counts times
          transparent, editable assumptions (every one shown below). Nothing here is fabricated — it's a live model you
          can interrogate.
        </p>
      </div>
      <div>
        <div className="head__meta">
          <strong>{fmtInt(snap.adoption.totalRuns)} runs</strong>
          <br />
          {fmtInt(
            snap.knowledge.contextPacks +
              snap.knowledge.decisions +
              snap.knowledge.featurePacks +
              snap.knowledge.features,
          )}{' '}
          knowledge assets
          <br />
          {snap.mode} · net {fmtUsdK(base.netValueUsd)} modeled
        </div>
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap', padding: '4px 0 20px' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Chip kind="measured" />
        <span style={{ fontSize: 12, color: 'var(--ink-dim)' }}>observed counts read from Coodra's tables.</span>
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Chip kind="modeled" />
        <span style={{ fontSize: 12, color: 'var(--ink-dim)' }}>
          derived = counts × editable assumptions (see methodology). Shown as a conservative–optimistic band.
        </span>
      </span>
    </div>
  );
}

/* ───────────────────────── TIER 0 · hero ───────────────────────── */

function Hero({
  base,
  conservative,
  optimistic,
  snap,
}: {
  base: RoiResult;
  conservative: RoiResult;
  optimistic: RoiResult;
  snap: RoiSnapshot;
}) {
  // Strictly > 0: an exactly-$0 net value (a fresh machine with no runs) renders
  // the neutral empty state rather than the celebratory accent border + glow.
  const netPositive = base.netValueUsd > 0;
  return (
    <div
      style={{
        border: `1px solid ${netPositive ? 'var(--accent)' : 'var(--rule-strong)'}`,
        background: netPositive ? 'var(--accent-glow)' : 'transparent',
        padding: '28px 32px',
        display: 'grid',
        gridTemplateColumns: 'minmax(280px, 1.2fr) 1fr',
        gap: 28,
        alignItems: 'center',
      }}
    >
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
              color: 'var(--ink-mute)',
            }}
          >
            North star · estimated net value delivered
          </span>
          <Chip kind="modeled" />
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
          <span
            style={{
              fontFamily: 'var(--serif)',
              fontSize: 64,
              lineHeight: 1,
              color: netPositive ? 'var(--accent)' : 'var(--ink)',
              fontWeight: 400,
            }}
          >
            {fmtUsdK(base.netValueUsd)}
          </span>
          <span style={{ fontSize: 13, color: 'var(--ink-dim)' }}>
            base case · range{' '}
            <strong style={{ color: 'var(--ink)' }}>
              {fmtUsdK(conservative.netValueUsd)}–{fmtUsdK(optimistic.netValueUsd)}
            </strong>{' '}
            (conservative–optimistic)
          </span>
        </div>
        <p style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.6, marginTop: 12, maxWidth: 560 }}>
          Benefit ({fmtUsdK(base.totalBenefitUsd)} = credits saved + developer time reclaimed) minus authoring
          investment ({fmtUsdK(base.investment.authoringUsd)}), over {fmtInt(snap.adoption.totalRuns)} recorded runs.
          Every term is itemized in <em>Efficiency &amp; ROI</em> and <em>Evidence</em> below.
        </p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: 'var(--rule)' }}>
        <HeroCell
          label="Benefit · cost ratio"
          value={fmtRatio(base.benefitCostRatio)}
          sub="every $1 authored returns"
        />
        <HeroCell label="ROI" value={fmtPct(base.roiPct)} sub="modeled, base case" />
        <HeroCell label="Credits saved" value={fmtUsdK(base.creditsSavedUsd.total)} sub="tokens + cache, all-time" />
        <HeroCell
          label="Time reclaimed"
          value={`${base.timeReclaimed.hours.toFixed(1)} h`}
          sub={`${fmtUsdK(base.timeReclaimed.usd)} of focus`}
        />
      </div>
    </div>
  );
}

function HeroCell({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div style={{ background: 'var(--bg)', padding: '16px 18px' }}>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 9,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--ink-mute)',
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div style={{ fontFamily: 'var(--serif)', fontSize: 30, color: 'var(--ink)', lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--ink-dim)', marginTop: 4 }}>{sub}</div>
    </div>
  );
}

/* ───────────────────────── leading indicators ───────────────────────── */

function LeadingRow({ snap }: { snap: RoiSnapshot }) {
  const k = snap.knowledge;
  return (
    <div className="stats" style={{ marginTop: 28 }}>
      <Tile
        label="Runs recorded"
        value={fmtInt(snap.adoption.totalRuns)}
        sub={`${fmtInt(snap.adoption.completedRuns)} completed · ${fmtInt(snap.adoption.activeProjects)} projects`}
        chip="measured"
      />
      <Tile
        label="Knowledge assets"
        value={fmtInt(k.contextPacks + k.decisions + k.featurePacks + k.features)}
        sub={`${fmtInt(k.contextPacks)} packs · ${fmtInt(k.decisions)} decisions`}
        tone="accent"
        chip="measured"
      />
      <Tile
        label="Governed actions"
        value={fmtInt(snap.governance.governedActions)}
        sub={`${fmtInt(snap.governance.blockedActions)} blocked · ${fmtInt(snap.governance.askActions)} ask`}
        chip="measured"
      />
      <Tile
        label="Reuse reads"
        value={fmtInt(k.reuseReads)}
        sub={
          k.reuseReads === 0
            ? 'capture armed · pass runId on reads'
            : `${fmtInt(k.runsWithReuse)} runs consulted prior work`
        }
        tone={k.reuseReads === 0 ? 'mute' : 'accent'}
        chip="measured"
      />
    </div>
  );
}

/* ───────────────────────── TIER 1 · A. adoption ───────────────────────── */

function AdoptionSection({ snap }: { snap: RoiSnapshot }) {
  const a = snap.adoption;
  const total = Math.max(1, a.totalRuns);
  return (
    <>
      <SectionHead
        num="A"
        title="Adoption &amp;"
        em="activity"
        caption="you can't bank value nobody uses"
        chip="measured"
      />
      <div className="dash-grid">
        <div>
          <div className="stats" style={{ marginBottom: 16 }}>
            <Tile
              label="Completed runs"
              value={fmtInt(a.completedRuns)}
              sub={`${fmtPct((a.completedRuns / total) * 100)} of all runs`}
              tone="accent"
            />
            <Tile label="In progress" value={fmtInt(a.inProgressRuns)} sub="live sessions" />
            <Tile
              label="Cancelled"
              value={fmtInt(a.cancelledRuns)}
              sub="stopped / stuck"
              tone={a.cancelledRuns > 0 ? 'caution' : 'mute'}
            />
            <Tile label="Tool calls" value={fmtInt(a.toolCalls)} sub="total agent actions traced" />
          </div>
          <AgentMix mix={a.agentMix} total={total} />
        </div>
        <div className="aside-card">
          <div className="aside-card__head">
            <h3 className="aside-card__title">
              Runs <em>per week</em>
            </h3>
            <span className="card__role">12 wk</span>
          </div>
          <div style={{ padding: '12px 0' }}>
            <Sparkline points={a.runsTrend} width={240} height={60} />
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                color: 'var(--ink-mute)',
                marginTop: 8,
                display: 'flex',
                justifyContent: 'space-between',
              }}
            >
              <span>{a.runsTrend[0]?.weekStart}</span>
              <span>now</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function AgentMix({ mix, total }: { mix: ReadonlyArray<RoiNamedCount>; total: number }) {
  if (mix.length === 0) return null;
  return (
    <div className="card" style={{ padding: '16px 20px' }}>
      <div className="card__head" style={{ marginBottom: 12 }}>
        <h3 className="card__title" style={{ fontSize: 16 }}>
          Agent <em>mix</em>
        </h3>
        <span className="card__role">runs by agent</span>
      </div>
      {mix.map((m) => (
        <LeverRow
          key={m.name}
          label={m.name}
          value={fmtInt(m.count)}
          pct={(m.count / total) * 100}
          color="var(--accent-soft)"
        />
      ))}
    </div>
  );
}

/* ───────────────────────── TIER 1 · B. governance ───────────────────────── */

function GovernanceSection({ snap }: { snap: RoiSnapshot }) {
  const g = snap.governance;
  const blocksArmed = g.blockedActions === 0;
  return (
    <>
      <SectionHead num="B" title="Governance &amp;" em="safety" caption="risk avoided is value too" chip="measured" />
      <div className="stats">
        <Tile
          label="Actions governed"
          value={fmtInt(g.governedActions)}
          sub="every agent action policy-checked"
          tone="accent"
        />
        <Tile
          label="Unsafe actions blocked"
          value={fmtInt(g.blockedActions)}
          sub={blocksArmed ? 'none yet · deny path armed' : 'runaway / unsafe writes stopped'}
          tone={blocksArmed ? 'mute' : 'warn'}
        />
        <Tile
          label="Ask-first prompts"
          value={fmtInt(g.askActions)}
          sub="held for human confirm"
          tone={g.askActions > 0 ? 'caution' : 'mute'}
        />
        <Tile
          label="Active kill switches"
          value={fmtInt(g.activeKillSwitches)}
          sub={g.activeKillSwitches === 0 ? 'no agents paused' : 'agents paused now'}
          tone={g.activeKillSwitches > 0 ? 'caution' : 'mute'}
        />
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--ink-dim)', lineHeight: 1.6, marginTop: 14, maxWidth: 760 }}>
        {blocksArmed ? (
          <>
            Coverage, not incidents, is the value here:{' '}
            <strong style={{ color: 'var(--ink)' }}>{fmtInt(g.governedActions)}</strong> agent actions passed through
            the policy engine and none required a block — the enforcement layer is armed and watching. Each future block
            prevents a runaway loop or an unsafe write (modeled in <em>Efficiency &amp; ROI</em>).
          </>
        ) : (
          <>
            <strong style={{ color: 'var(--warn)' }}>{fmtInt(g.blockedActions)}</strong> unsafe or runaway actions were
            stopped before they ran, out of <strong style={{ color: 'var(--ink)' }}>{fmtInt(g.governedActions)}</strong>{' '}
            governed actions — each one a prevented cleanup or credit spike.
          </>
        )}
      </p>
    </>
  );
}

/* ───────────────────────── TIER 1 · C. knowledge ───────────────────────── */

function KnowledgeSection({ snap }: { snap: RoiSnapshot }) {
  const k = snap.knowledge;
  return (
    <>
      <SectionHead num="C" title="Knowledge" em="capitalization" caption="the compounding asset" chip="measured" />
      <div className="dash-grid">
        <div>
          <div className="stats" style={{ marginBottom: 16 }}>
            <Tile
              label="Context packs"
              value={fmtInt(k.contextPacks)}
              sub={`${fmtInt(k.agentAuthoredPacks)} agent · ${fmtInt(k.bridgeAutoPacks)} auto`}
              tone="accent"
            />
            <Tile
              label="Decisions"
              value={fmtInt(k.decisions)}
              sub={`${fmtPct(k.decisionCompletenessPct)} complete (DIQ)`}
            />
            <Tile
              label="Feature packs · features"
              value={`${fmtInt(k.featurePacks)} · ${fmtInt(k.features)}`}
              sub="module blueprints · skills"
            />
            <Tile
              label="Wiki pages"
              value={fmtInt(k.wikiPagesAuthored)}
              sub={`of ${fmtInt(k.wikiPages)} · ${fmtInt(k.wikis)} wikis`}
            />
          </div>

          <div className="card" style={{ padding: '18px 22px' }}>
            <div className="card__head" style={{ marginBottom: 8 }}>
              <h3 className="card__title" style={{ fontSize: 16 }}>
                Reuse &amp; <em>continuity</em>
              </h3>
              <span className="card__role">KCS link rate</span>
            </div>
            {k.reuseReads === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.6 }}>
                <strong style={{ color: 'var(--ink)' }}>0</strong> reuse-reads recorded yet. Capture is{' '}
                <strong style={{ color: 'var(--accent)' }}>armed</strong>: when an agent passes its{' '}
                <code style={inlineMono}>runId</code> to <code style={inlineMono}>search_packs_nl</code>,{' '}
                <code style={inlineMono}>get_feature_pack</code>, <code style={inlineMono}>query_run_history</code> or
                peers (per the trigger contract), each consultation lands as an <code style={inlineMono}>mcp_call</code>{' '}
                event and accrues here — proving the agent consulted prior work instead of re-deriving it.
              </p>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 12 }}>
                  <span style={{ fontFamily: 'var(--serif)', fontSize: 40, color: 'var(--accent)', lineHeight: 1 }}>
                    {fmtPct(k.linkRatePct)}
                  </span>
                  <span style={{ fontSize: 12.5, color: 'var(--ink-dim)' }}>
                    of completed runs consulted prior knowledge ({fmtInt(k.runsWithReuse)} of{' '}
                    {fmtInt(snap.adoption.completedRuns)}). KCS target 60–80%.
                  </span>
                </div>
                {k.reuseByTool.map((t) => (
                  <LeverRow
                    key={t.name}
                    label={toolShort(t.name)}
                    value={fmtInt(t.count)}
                    pct={(t.count / Math.max(1, k.reuseReads)) * 100}
                    color="var(--accent-soft)"
                  />
                ))}
              </>
            )}
          </div>
        </div>

        <div>
          <div className="aside-card">
            <div className="aside-card__head">
              <h3 className="aside-card__title">
                Assets <em>per week</em>
              </h3>
              <span className="card__role">12 wk</span>
            </div>
            <div style={{ padding: '12px 0' }}>
              <Sparkline points={k.assetsTrend} width={240} height={56} color="var(--accent)" />
            </div>
          </div>

          <div className="aside-card">
            <div className="aside-card__head">
              <h3 className="aside-card__title">
                Health <em>signals</em>
              </h3>
            </div>
            <MetricRow
              label="Knowledge captured"
              value={`${fmtTokens(Math.round(k.knowledgeCapturedChars / DEFAULT_ROI_CONSTANTS.charsPerToken))} tok`}
              sub="durable corpus (chars ÷ 4)"
            />
            <MetricRow label="Packs → decisions" value={fmtInt(k.packsLinkingDecisions)} sub="cross-linked records" />
            <MetricRow
              label="Avg asset age"
              value={k.avgAssetAgeDays === null ? '—' : `${Math.round(k.avgAssetAgeDays)} d`}
              sub={`${fmtPct(k.stalePct)} stale (>90d)`}
            />
            <MetricRow
              label="Author concentration"
              value={k.topAuthorShare === null ? 'solo' : fmtPct(k.topAuthorShare)}
              sub="top contributor share (bus-factor)"
              last
            />
          </div>
        </div>
      </div>
    </>
  );
}

function MetricRow({ label, value, sub, last }: { label: string; value: string; sub: string; last?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        padding: '11px 0',
        borderBottom: last ? 'none' : '1px solid var(--rule)',
      }}
    >
      <div>
        <div style={{ fontSize: 13.5, color: 'var(--ink)' }}>{label}</div>
        <div className="row__sub">{sub}</div>
      </div>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--ink)' }}>{value}</div>
    </div>
  );
}

/* ───────────────────────── TIER 1 · D. impact (modeled) ───────────────────────── */

function ImpactSection({
  base,
  conservative,
  optimistic,
  snap,
}: {
  base: RoiResult;
  conservative: RoiResult;
  optimistic: RoiResult;
  snap: RoiSnapshot;
}) {
  const t = base.tokensSaved;
  const c = base.creditsSavedUsd;
  const maxTok = Math.max(1, t.compression, t.reuse, t.cache, t.loopPrevented);
  return (
    <>
      <SectionHead num="D" title="Efficiency &amp;" em="ROI" caption="modeled from the counts above" chip="modeled" />
      <div className="dash-grid">
        <div className="card" style={{ padding: '18px 22px' }}>
          <div className="card__head" style={{ marginBottom: 10 }}>
            <h3 className="card__title" style={{ fontSize: 16 }}>
              Tokens <em>saved</em> · {fmtTokens(t.total)}
            </h3>
            <span className="card__role">by lever</span>
          </div>
          <LeverRow label="Context compression" value={fmtTokens(t.compression)} pct={(t.compression / maxTok) * 100} />
          <LeverRow label="Reuse (no re-derivation)" value={fmtTokens(t.reuse)} pct={(t.reuse / maxTok) * 100} />
          <LeverRow
            label="Prompt-cache (net)"
            value={fmtTokens(t.cache)}
            pct={(t.cache / maxTok) * 100}
            color="var(--accent-soft)"
          />
          <LeverRow
            label="Runaway loops prevented"
            value={fmtTokens(t.loopPrevented)}
            pct={(t.loopPrevented / maxTok) * 100}
            color="var(--caution)"
          />
          <div
            style={{
              borderTop: '1px solid var(--rule)',
              marginTop: 10,
              paddingTop: 12,
              fontSize: 12.5,
              color: 'var(--ink-dim)',
            }}
          >
            Priced at the <strong style={{ color: 'var(--ink)' }}>{DEFAULT_ROI_CONSTANTS.modelKey}</strong> input rate →{' '}
            <strong style={{ color: 'var(--accent)' }}>{fmtUsdK(c.total)}</strong> in credits saved.
          </div>
        </div>

        <div>
          <div className="stats" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <Tile
              label="Credits saved"
              value={fmtUsdK(c.total)}
              sub="token + cache spend avoided"
              tone="accent"
              chip="modeled"
            />
            <Tile
              label="Time reclaimed"
              value={`${base.timeReclaimed.hours.toFixed(1)} h`}
              sub={`${fmtUsdK(base.timeReclaimed.usd)} of focus`}
              tone="accent"
              chip="modeled"
            />
            <Tile
              label="Authoring cost"
              value={fmtUsdK(base.investment.authoringUsd)}
              sub={`${base.investment.authoringHours.toFixed(1)} h invested`}
              tone="caution"
              chip="modeled"
            />
            <Tile
              label="Net value"
              value={fmtUsdK(base.netValueUsd)}
              sub={`BCR ${fmtRatio(base.benefitCostRatio)} · ROI ${fmtPct(base.roiPct)}`}
              tone={base.netValueUsd >= 0 ? 'accent' : 'warn'}
              chip="modeled"
            />
          </div>
          <div className="card" style={{ padding: '16px 20px', marginTop: 16 }}>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'var(--ink-mute)',
                marginBottom: 10,
              }}
            >
              Scenario band · net value
            </div>
            <ScenarioBar label="Conservative" r={conservative} max={Math.max(optimistic.netValueUsd, 1)} />
            <ScenarioBar label="Base" r={base} max={Math.max(optimistic.netValueUsd, 1)} highlight />
            <ScenarioBar label="Optimistic" r={optimistic} max={Math.max(optimistic.netValueUsd, 1)} />
            <p style={{ fontSize: 11.5, color: 'var(--ink-mute)', marginTop: 10, lineHeight: 1.5 }}>
              From {fmtInt(snap.modeledInputs.reuseReads)} reuse-reads, {fmtInt(snap.modeledInputs.blockedActions)}{' '}
              blocks and {fmtInt(snap.modeledInputs.totalRuns)} runs. Edit the assumptions below to move every figure.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}

function ScenarioBar({ label, r, max, highlight }: { label: string; r: RoiResult; max: number; highlight?: boolean }) {
  const pct = (Math.max(0, r.netValueUsd) / max) * 100;
  return (
    <div
      style={{ display: 'grid', gridTemplateColumns: '96px 1fr 70px', gap: 12, alignItems: 'center', padding: '6px 0' }}
    >
      <div
        style={{ fontSize: 12, color: highlight ? 'var(--ink)' : 'var(--ink-dim)', fontWeight: highlight ? 600 : 400 }}
      >
        {label}
      </div>
      <Meter pct={pct} color={highlight ? 'var(--accent)' : 'var(--accent-soft)'} />
      <div style={{ fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'right', color: 'var(--ink)' }}>
        {fmtUsdK(r.netValueUsd)}
      </div>
    </div>
  );
}

/* ───────────────────────── TIER 2 · evidence ───────────────────────── */

function EvidenceSection({ methodology }: { methodology: ReadonlyArray<MethodologyRow> }) {
  return (
    <>
      <SectionHead num="E" title="Evidence &amp;" em="derivation" caption="every modeled $ = counts × constants" />
      <div className="card" style={{ padding: '6px 0' }}>
        {methodology.map((row, i) => (
          <div
            key={row.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '200px 1fr 120px',
              gap: 16,
              padding: '14px 22px',
              borderTop: i === 0 ? 'none' : '1px solid var(--rule)',
              alignItems: 'baseline',
            }}
          >
            <div>
              <div style={{ fontSize: 13.5, color: 'var(--ink)' }}>{row.label}</div>
              <ConfidenceTag c={row.confidence} />
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--ink-dim)', lineHeight: 1.6 }}>
              {row.formula}
              <div style={{ color: 'var(--ink-mute)', marginTop: 3 }}>{row.source}</div>
            </div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink)', textAlign: 'right' }}>
              {row.value}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function ConfidenceTag({ c }: { c: 'high' | 'medium' | 'low' }) {
  const color = c === 'high' ? 'var(--accent)' : c === 'medium' ? 'var(--caution)' : 'var(--ink-mute)';
  return (
    <span
      style={{
        fontFamily: 'var(--mono)',
        fontSize: 8.5,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color,
        marginTop: 4,
        display: 'inline-block',
      }}
    >
      {c} confidence
    </span>
  );
}

/* ───────────────────────── TIER 3 · assumptions ───────────────────────── */

function AssumptionsSection({ isTeamHosted }: { isTeamHosted: boolean }) {
  const k = DEFAULT_ROI_CONSTANTS;
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Model rate card', value: `${k.modelKey} · $5/$25 per MTok, cache-read 0.1×` },
    { label: 'Chars per token', value: `${k.charsPerToken}` },
    { label: 'Discovery tokens / session (naive baseline)', value: `${fmtInt(k.baselineDiscoveryTokensPerSession)}` },
    { label: 'Injected prefix tokens', value: `${fmtInt(k.injectedPrefixTokens)}` },
    { label: 'Re-derivation tokens / reuse', value: `${fmtInt(k.rederivationTokensPerReuse)}` },
    { label: 'Runaway tokens / block', value: `${fmtInt(k.runawayTokensPerBlock)}` },
    {
      label: 'Minutes reclaimed / reuse · / block',
      value: `${k.minutesReclaimedPerReuse} · ${k.minutesReclaimedPerBlock}`,
    },
    { label: 'Blended developer rate', value: `$${k.blendedHourlyUsd}/h` },
    { label: 'Minutes to author one asset', value: `${k.minutesPerAssetAuthored}` },
  ];
  return (
    <>
      <SectionHead num="F" title="Assumptions &amp;" em="methodology" caption="change these → every $ moves" />
      <div className="dash-grid">
        <div className="card" style={{ padding: '6px 0' }}>
          {rows.map((r, i) => (
            <div
              key={r.label}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                gap: 16,
                padding: '11px 22px',
                borderTop: i === 0 ? 'none' : '1px solid var(--rule)',
              }}
            >
              <span style={{ fontSize: 13, color: 'var(--ink-dim)' }}>{r.label}</span>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--ink)', textAlign: 'right' }}>
                {r.value}
              </span>
            </div>
          ))}
        </div>
        <div className="aside-card">
          <div className="aside-card__head">
            <h3 className="aside-card__title">
              How to <em>read</em> this
            </h3>
          </div>
          <p style={{ fontSize: 13, color: 'var(--ink-dim)', lineHeight: 1.65 }}>
            Defaults are deliberately <strong style={{ color: 'var(--ink)' }}>conservative</strong>, sourced from
            Anthropic's published rate card, the Parnin/van&nbsp;Solingen interruption studies (10–15 min to resume),
            and DX's $78/h fully-loaded developer cost. Override them via{' '}
            <code style={inlineMono}>coodra roi --hourly-rate</code> / model env, and the whole model recomputes.
          </p>
          <p style={{ fontSize: 12, color: 'var(--ink-mute)', lineHeight: 1.6, marginTop: 12 }}>
            Observed counts are measured from Coodra's own tables. Dollars are <em>modeled estimates</em> with a stated
            band, not invoices — the honest line between what we count and what we infer.
          </p>
          {isTeamHosted ? null : (
            <p style={{ fontSize: 11.5, color: 'var(--ink-mute)', lineHeight: 1.6, marginTop: 12 }}>
              Solo / local-team reads this machine's <code style={inlineMono}>~/.coodra/data.db</code>. Org-wide team
              totals aggregate in the team-hosted web.
            </p>
          )}
          <div style={{ marginTop: 16, borderTop: '1px solid var(--rule)', paddingTop: 12 }}>
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 9,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'var(--ink-mute)',
                marginBottom: 8,
              }}
            >
              Sources
            </div>
            {ROI_SOURCES.map((s) => (
              <a
                key={s.url}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'block',
                  fontSize: 11.5,
                  color: 'var(--ink-dim)',
                  textDecoration: 'none',
                  padding: '3px 0',
                }}
              >
                ↗ {s.label}
              </a>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

const inlineMono: React.CSSProperties = { fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--accent)' };
