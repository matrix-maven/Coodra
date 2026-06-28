import { listProjects, type ProjectListRow } from '@coodra/db';
import {
  computeRoiBand,
  DEFAULT_ROI_CONSTANTS,
  REUSE_READ_TOOL_NAMES,
  type RoiMeasuredInputs,
} from '@coodra/shared/roi';

import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { resolveCoodraDataDb, resolveCoodraHome } from '../lib/coodra-home.js';
import { openLocalDb } from '../lib/open-local-db.js';
import { readTeamConfig } from '../lib/team-config.js';
import {
  commandTitle,
  errorLine,
  hintLine,
  type KvRow,
  kvBlock,
  sectionHead,
  summaryBar,
  terminalWidth,
} from '../ui/index.js';

/**
 * `coodra metrics` (alias `coodra roi`) — print Coodra's ROI / value KPIs
 * for THIS machine's local store. Measured counts come straight from
 * `~/.coodra/data.db`; dollar/token figures are MODELED via the shared
 * `@coodra/shared/roi` model (identical math to the `/roi` web dashboard),
 * with the assumptions printed at the foot. No cloud read — in team mode the
 * org-wide rollup lives in the team-hosted web (a hint is printed).
 */

export interface MetricsOptions {
  readonly json?: boolean;
  /** Limit the per-project breakdown to a single project slug. */
  readonly project?: string;
}

export interface MetricsIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
  /** Override the home dir (tests / dev-loop). */
  readonly coodraHome?: string;
}

export const DEFAULT_METRICS_IO: MetricsIO = {
  writeStdout: (chunk) => {
    process.stdout.write(chunk);
  },
  writeStderr: (chunk) => {
    process.stderr.write(chunk);
  },
  exit: (code) => process.exit(code),
};

interface MetricsReport {
  readonly mode: 'solo' | 'team';
  readonly measured: {
    readonly totalRuns: number;
    readonly completedRuns: number;
    readonly toolCalls: number;
    readonly governedActions: number;
    readonly blockedActions: number;
    readonly askActions: number;
    readonly contextPacks: number;
    readonly agentPacks: number;
    readonly decisions: number;
    readonly featurePacks: number;
    readonly features: number;
    readonly wikiPages: number;
    readonly reuseReads: number;
    readonly runsWithReuse: number;
    readonly linkRatePct: number | null;
    readonly knowledgeCapturedTokens: number;
  };
  readonly modeled: {
    readonly netValueUsd: number;
    readonly netValueRange: readonly [number, number];
    readonly benefitCostRatio: number | null;
    readonly roiPct: number | null;
    readonly creditsSavedUsd: number;
    readonly tokensSaved: number;
    readonly timeReclaimedHours: number;
    readonly authoringUsd: number;
  };
  readonly reuseByTool: ReadonlyArray<{ readonly tool: string; readonly count: number }>;
  readonly perProject: ReadonlyArray<{
    readonly slug: string;
    readonly runs: number;
    readonly lastRunAt: string | null;
  }>;
}

export async function runMetricsCommand(options: MetricsOptions, ioOverride?: MetricsIO): Promise<void> {
  const io = ioOverride ?? DEFAULT_METRICS_IO;
  const json = options.json === true;
  const homePath = io.coodraHome ?? resolveCoodraHome();
  const mode = readTeamConfig(io.coodraHome !== undefined ? { homeOverride: io.coodraHome } : {}).mode;

  const handle = await openLocalDb(resolveCoodraDataDb(homePath));
  try {
    const one = (sqlText: string, ...params: unknown[]): number => {
      const row = handle.raw.prepare(sqlText).get(...params) as { n: number | null } | undefined;
      return Number(row?.n ?? 0);
    };

    const reuseNames = [...REUSE_READ_TOOL_NAMES];
    const ph = reuseNames.map(() => '?').join(',');

    const totalRuns = one('SELECT COUNT(*) AS n FROM runs');
    const completedRuns = one("SELECT COUNT(*) AS n FROM runs WHERE status = 'completed'");
    const toolCalls = one('SELECT COUNT(*) AS n FROM run_events');
    const governedActions = one('SELECT COUNT(*) AS n FROM policy_decisions');
    const blockedActions = one("SELECT COUNT(*) AS n FROM policy_decisions WHERE permission_decision = 'deny'");
    const askActions = one("SELECT COUNT(*) AS n FROM policy_decisions WHERE permission_decision = 'ask'");
    const contextPacks = one('SELECT COUNT(*) AS n FROM context_packs');
    const agentPacks = one("SELECT COUNT(*) AS n FROM context_packs WHERE source = 'agent'");
    const decisions = one('SELECT COUNT(*) AS n FROM decisions');
    const featurePacks = one('SELECT COUNT(*) AS n FROM feature_packs');
    const features = one('SELECT COUNT(*) AS n FROM features');
    const wikiPages = one("SELECT COUNT(*) AS n FROM wiki_pages WHERE state = 'authored'");
    const reuseReads = one(
      `SELECT COUNT(*) AS n FROM run_events WHERE phase = 'mcp_call' AND tool_name IN (${ph})`,
      ...reuseNames,
    );
    // Numerator restricted to COMPLETED runs (JOIN runs ... status='completed')
    // so linkRatePct (÷ completedRuns) is bounded ≤100% — matches web roi.ts.
    const runsWithReuse = one(
      `SELECT COUNT(DISTINCT re.run_id) AS n FROM run_events re JOIN runs r ON r.id = re.run_id WHERE re.phase = 'mcp_call' AND re.tool_name IN (${ph}) AND r.status = 'completed'`,
      ...reuseNames,
    );
    const packChars = one('SELECT COALESCE(SUM(LENGTH(content)), 0) AS n FROM context_packs');
    const decisionChars = one('SELECT COALESCE(SUM(LENGTH(description) + LENGTH(rationale)), 0) AS n FROM decisions');

    const reuseByToolRows = handle.raw
      .prepare(
        `SELECT tool_name AS tool, COUNT(*) AS n FROM run_events WHERE phase = 'mcp_call' AND tool_name IN (${ph}) GROUP BY tool_name ORDER BY n DESC`,
      )
      .all(...reuseNames) as Array<{ tool: string; n: number }>;

    let projects: ProjectListRow[] = await listProjects(handle);
    if (options.project !== undefined && options.project.length > 0) {
      const wanted = options.project;
      projects = projects.filter((p) => p.slug === wanted);
      if (projects.length === 0) {
        return surfaceError(io, json, EXIT_USER_RECOVERABLE, `project slug "${wanted}" is not registered`);
      }
    }

    const modeledInputs: RoiMeasuredInputs = {
      totalRuns,
      completedRuns,
      toolCalls,
      reuseReads,
      assetsAuthored: agentPacks + decisions,
      governedActions,
      blockedActions,
      assetContentChars: packChars + decisionChars,
    };
    const band = computeRoiBand(modeledInputs, DEFAULT_ROI_CONSTANTS);

    const report: MetricsReport = {
      mode,
      measured: {
        totalRuns,
        completedRuns,
        toolCalls,
        governedActions,
        blockedActions,
        askActions,
        contextPacks,
        agentPacks,
        decisions,
        featurePacks,
        features,
        wikiPages,
        reuseReads,
        runsWithReuse,
        linkRatePct: completedRuns > 0 ? (runsWithReuse / completedRuns) * 100 : null,
        knowledgeCapturedTokens: band.base.knowledgeCapturedTokens ?? 0,
      },
      modeled: {
        netValueUsd: band.base.netValueUsd,
        netValueRange: [band.conservative.netValueUsd, band.optimistic.netValueUsd],
        benefitCostRatio: band.base.benefitCostRatio,
        roiPct: band.base.roiPct,
        creditsSavedUsd: band.base.creditsSavedUsd.total,
        tokensSaved: band.base.tokensSaved.total,
        timeReclaimedHours: band.base.timeReclaimed.hours,
        authoringUsd: band.base.investment.authoringUsd,
      },
      reuseByTool: reuseByToolRows.map((r) => ({ tool: r.tool, count: Number(r.n) })),
      perProject: projects.map((p) => ({
        slug: p.slug,
        runs: p.runCount,
        lastRunAt: p.lastRunAt?.toISOString() ?? null,
      })),
    };

    if (json) {
      io.writeStdout(`${JSON.stringify({ ok: true, ...report }, null, 2)}\n`);
    } else {
      io.writeStdout(formatHuman(report));
    }
    return io.exit(EXIT_OK);
  } finally {
    handle.close();
  }
}

/* ───────────────────────── formatting ───────────────────────── */

const fmtInt = (n: number): string => Math.round(n).toLocaleString();
const fmtUsd = (n: number): string => (Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(2)}`);
const fmtPct = (n: number | null): string => (n === null ? '—' : `${n.toFixed(0)}%`);
const fmtRatio = (n: number | null): string => (n === null ? '—' : `${n.toFixed(1)}x`);
const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : `${Math.round(n)}`;
const shortTool = (t: string): string => t.replace(/^coodra__/, '');

function formatHuman(r: MetricsReport): string {
  const width = terminalWidth();
  const out: string[] = [];
  out.push(commandTitle('ROI', 'Coodra — return on context', { width, indent: 0 }));
  out.push('');
  out.push(
    summaryBar(
      [
        {
          text: `net ${fmtUsd(r.modeled.netValueUsd)} modeled`,
          tone: r.modeled.netValueUsd >= 0 ? 'phosphor' : 'crimson',
          bold: true,
        },
        { text: `${fmtRatio(r.modeled.benefitCostRatio)} benefit·cost` },
        { text: `${fmtPct(r.modeled.roiPct)} ROI` },
        { text: `${fmtInt(r.measured.totalRuns)} runs` },
      ],
      { indent: 2 },
    ),
  );
  out.push('');

  out.push(sectionHead('01', 'impact · modeled', { width }));
  out.push(
    kvBlock(
      [
        {
          key: 'net value',
          value: fmtUsd(r.modeled.netValueUsd),
          meta: `· range ${fmtUsd(r.modeled.netValueRange[0])}–${fmtUsd(r.modeled.netValueRange[1])}`,
          valueTone: r.modeled.netValueUsd >= 0 ? 'phosphor' : 'crimson',
        },
        {
          key: 'credits saved',
          value: fmtUsd(r.modeled.creditsSavedUsd),
          meta: `· ${fmtTokens(r.modeled.tokensSaved)} tokens`,
          valueTone: 'phosphor',
        },
        { key: 'time reclaimed', value: `${r.modeled.timeReclaimedHours.toFixed(1)} h` },
        { key: 'authoring cost', value: fmtUsd(r.modeled.authoringUsd), valueTone: 'amber' },
      ],
      { keyWidth: 20, indent: 2 },
    ),
  );
  out.push('');

  out.push(sectionHead('02', 'knowledge capitalization · measured', { width }));
  out.push(
    kvBlock(
      [
        {
          key: 'context packs',
          value: fmtInt(r.measured.contextPacks),
          meta: `· ${fmtInt(r.measured.agentPacks)} agent-authored`,
        },
        { key: 'decisions', value: fmtInt(r.measured.decisions) },
        {
          key: 'feature packs',
          value: fmtInt(r.measured.featurePacks),
          meta: `· ${fmtInt(r.measured.features)} features`,
        },
        { key: 'wiki pages', value: fmtInt(r.measured.wikiPages) },
        {
          key: 'knowledge captured',
          value: `${fmtTokens(r.measured.knowledgeCapturedTokens)} tok`,
          meta: '· est · chars ÷ 4',
          valueTone: 'inkDim',
        },
        {
          key: 'reuse reads',
          value: fmtInt(r.measured.reuseReads),
          meta:
            r.measured.reuseReads === 0
              ? '· capture armed — pass runId on reads'
              : `· ${fmtPct(r.measured.linkRatePct)} link rate (KCS 60-80%)`,
          valueTone: r.measured.reuseReads === 0 ? 'inkFar' : 'phosphor',
        },
      ],
      { keyWidth: 20, indent: 2 },
    ),
  );
  if (r.reuseByTool.length > 0) {
    out.push(
      kvBlock(
        r.reuseByTool.map((t) => ({
          key: `  ${shortTool(t.tool)}`,
          value: fmtInt(t.count),
          valueTone: 'inkDim' as const,
        })),
        { keyWidth: 24, indent: 2 },
      ),
    );
  }
  out.push('');

  out.push(sectionHead('03', 'governance · measured', { width }));
  out.push(
    kvBlock(
      [
        {
          key: 'actions governed',
          value: fmtInt(r.measured.governedActions),
          meta: '· every agent action policy-checked',
          valueTone: 'phosphor',
        },
        {
          key: 'blocked',
          value: fmtInt(r.measured.blockedActions),
          meta: r.measured.blockedActions === 0 ? '· none yet — deny path armed' : '· unsafe/runaway stopped',
          valueTone: r.measured.blockedActions > 0 ? 'crimson' : 'inkFar',
        },
        {
          key: 'ask-first',
          value: fmtInt(r.measured.askActions),
          valueTone: r.measured.askActions > 0 ? 'amber' : 'inkFar',
        },
      ],
      { keyWidth: 20, indent: 2 },
    ),
  );
  out.push('');

  out.push(sectionHead('04', 'per project', { width }));
  if (r.perProject.length === 0) {
    out.push(`  ${hintLine('(no projects registered yet — run `coodra init`)')}`);
  } else {
    const rows: KvRow[] = r.perProject
      .slice()
      .sort((a, b) => b.runs - a.runs)
      .slice(0, 12)
      .map((p) => ({
        key: p.slug,
        value: `${fmtInt(p.runs)} runs`,
        meta: p.lastRunAt !== null ? `· ${p.lastRunAt.slice(0, 10)}` : '· no runs',
        valueTone: p.runs > 0 ? ('ink' as const) : ('inkFar' as const),
      }));
    out.push(kvBlock(rows, { keyWidth: 28, indent: 2 }));
  }
  out.push('');

  // Methodology footer — make the modeled numbers auditable inline.
  const k = DEFAULT_ROI_CONSTANTS;
  out.push(
    `  ${hintLine(`modeled at ${k.modelKey} rates · $${k.blendedHourlyUsd}/h · ${fmtInt(k.baselineDiscoveryTokensPerSession)} discovery tok/session · 10–15 min/reuse (Parnin). Override via env; full methodology on the /roi web dashboard.`)}`,
  );
  if (r.mode === 'team') {
    out.push(`  ${hintLine('team mode: org-wide totals across teammates aggregate in the team-hosted web (/roi).')}`);
  }
  return `${out.join('\n')}\n`;
}

function surfaceError(io: MetricsIO, json: boolean, exitCode: number, message: string): void {
  if (json) {
    io.writeStdout(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  } else {
    io.writeStderr(`${errorLine(message)}\n`);
  }
  io.exit(exitCode);
}
