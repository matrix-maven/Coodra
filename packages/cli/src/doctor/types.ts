/**
 * Severity tier per spec §4.5. Each check declares the maximum severity it
 * can emit; the runner records the actual outcome as a `CheckStatus`. Reds
 * map to fix-required-now; yellows to operational warnings; greens to clean.
 */
export type CheckSeverity = 'red' | 'yellow' | 'green-or-yellow' | 'permanent-yellow';

export type CheckStatus = 'green' | 'yellow' | 'red' | 'skipped' | 'timeout';

export interface CheckResult {
  readonly status: CheckStatus;
  readonly detail?: string;
  readonly remediation?: string;
}

export interface CheckContext {
  /** Resolved `~/.coodra/` per spec §11 Decision 2. */
  readonly coodraHome: string;
  /** Path to `<coodraHome>/data.db`. */
  readonly dataDb: string;
  /** Resolved cwd (project root candidate). */
  readonly cwd: string;
  /** Captured env so the runner is testable without mutating process.env. */
  readonly env: NodeJS.ProcessEnv;
  /** MCP server port (from env or 3100 default). */
  readonly mcpPort: number;
  /** Hooks bridge port (from env or 3101 default). */
  readonly bridgePort: number;
  /** Web dashboard port (from COODRA_WEB_PORT or 3001 default). W1 (2026-05-13). */
  readonly webPort: number;
  /** Stable clock for tests. */
  readonly now: () => Date;
  /** Per-check timeout in ms (set by `--timeout-ms`, default 2000). */
  readonly timeoutMs: number;
  /** Platform (defaults to process.platform). Tests override. */
  readonly platform: NodeJS.Platform;
  /** Node version (defaults to process.versions.node). Tests override. */
  readonly nodeVersion: string;
}

export interface Check {
  readonly id: number;
  readonly name: string;
  readonly severity: CheckSeverity;
  /**
   * Essential checks run by default — they certify the load-bearing
   * invariants of the Claude Code + solo-mode happy path. Non-
   * essential checks (debug invariants, outbox observability,
   * team-mode-only probes) only run with `--full`. Decision
   * dec_83ba10c1 (2026-05-02) trimmed the default surface from 27
   * to ~9; the rest stay in the registry for opt-in inspection.
   *
   * Per-check files leave this field unset — the registry tags it
   * via `tagEssential` against an authoritative ID set, so adding
   * a new check is a one-line registry change rather than a per-
   * file edit. Treated as `false` when undefined.
   */
  readonly essential?: boolean;
  /** Run the check; must always resolve (use `try/catch` internally). */
  run(context: CheckContext): Promise<CheckResult>;
}

export interface CheckRunResult {
  readonly id: number;
  readonly name: string;
  readonly severity: CheckSeverity;
  readonly status: CheckStatus;
  readonly detail?: string;
  readonly remediation?: string;
  /** Wall-clock ms the check took. */
  readonly durationMs: number;
}

export interface DoctorReport {
  readonly version: string;
  readonly coodraHome: string;
  readonly cwd: string;
  readonly checks: readonly CheckRunResult[];
  readonly summary: {
    readonly ok: number;
    readonly warn: number;
    readonly fail: number;
    readonly skipped: number;
  };
}
