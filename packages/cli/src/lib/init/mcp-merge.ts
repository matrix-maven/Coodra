export interface BuildMcpEntryOptions {
  /**
   * Absolute path to the bundled mcp-server binary. The init command
   * resolves this via `lib/runtime-paths.ts::resolveRuntimeBinary` —
   * which prefers the bundled `<cli-dist>/runtime/mcp-server/index.js`
   * (npm-install case) and falls back to `apps/mcp-server/dist/index.js`
   * (monorepo dev). If neither exists init throws with a structured
   * remediation BEFORE this builder runs, so the value is always a real
   * path here.
   */
  readonly mcpServerBin: string;
  /** Solo-mode bypass token to set on the MCP entry. Always solo-only. */
  readonly clerkSecretKey: string;
  /**
   * Absolute path to the bundled drizzle migrations folder, when the
   * runtime resolver detected a bundled deploy. `null` when the CLI
   * is running from a workspace checkout — in that case the bundled
   * mcp-server's `MIGRATIONS_FOLDER.sqlite` resolves correctly via
   * `@coodra/db`'s own `import.meta.url`.
   */
  readonly migrationsDir?: string | null;
  /**
   * Absolute path to the resolved COODRA_HOME. When set, the spawned
   * MCP server reads/writes the project's local SQLite (in this home)
   * instead of the user's default `~/.coodra/` — eliminating the
   * split-brain where the bridge's audit chain lives in the project home
   * but the MCP server's record_decision / save_context_pack writes go
   * to a totally different SQLite database.
   */
  readonly coodraHome?: string;
  /**
   * Phase F.6+ (2026-05-12) — machine mode. When set to 'team', the MCP
   * child process spawned by Claude Code knows to enqueue `sync_to_cloud`
   * jobs on every record_decision / save_context_pack write so the
   * sync-daemon pushes them to cloud Postgres.
   *
   * Without this, Claude Code's MCP child inherits its env from Claude's
   * shell — which doesn't auto-load ~/.coodra/.env. Result:
   * COODRA_MODE defaults to 'solo' inside the child, sync skips, every
   * decision/pack stays local-only, teammates never see admin's work.
   * Symptom: web /decisions and /context-packs render empty even after
   * the user successfully ran the MCP tools.
   */
  readonly mode?: 'solo' | 'team';
  /**
   * Phase F.6+ — cloud Postgres URL. The MCP child's sync enqueue path
   * actually only needs the local SQLite handle, but the sync-daemon
   * (which dispatches the queue) needs DATABASE_URL. We inline it here
   * so even an MCP child run from a shell that hasn't sourced
   * ~/.coodra/.env still has it for any cloud-direct paths.
   */
  readonly databaseUrl?: string;
  /**
   * Phase F.6+ — local hook secret literal. Kept in lockstep with the
   * daemon's secret so Claude Code's hook substitutions match. Distinct
   * from the project `.env`'s LOCAL_HOOK_SECRET — that file isn't
   * auto-loaded by shells.
   */
  readonly localHookSecret?: string;
  /**
   * Which agent this MCP entry is written FOR (`claude_code` / `codex` /
   * `cursor`). Stamped as `COODRA_AGENT_TYPE` in the entry's
   * env so the spawned stdio server can attribute `runs.agent_type` even
   * when the client's `initialize.clientInfo.name` is one the server's
   * mapping table has never seen (the observed failure: Codex ships
   * 'codex-mcp-client', which stamped every Codex run 'unknown' in the
   * web app). The server treats the stamp as a FALLBACK — a clientInfo
   * name that maps always wins (`apps/mcp-server/src/lib/agent-type.ts::
   * resolveAgentType`). Safe per-entry because each agent has its own
   * config file and spawns its own server process.
   */
  readonly agentType?: 'claude_code' | 'codex' | 'cursor' | 'devin' | 'antigravity';
}

export interface CoodraMcpEntry {
  readonly command: string;
  readonly args?: string[];
  readonly env?: Record<string, string>;
}

/** Build the canonical plugin-scoped `coodra` stdio MCP entry. */
export function buildCoodraMcpEntry(options: BuildMcpEntryOptions): CoodraMcpEntry {
  const env: Record<string, string> = {
    COODRA_LOG_DESTINATION: 'stderr',
    CLERK_SECRET_KEY: options.clerkSecretKey,
  };
  if (typeof options.migrationsDir === 'string' && options.migrationsDir.length > 0) {
    // Tells the bundled mcp-server's `@coodra/db::MIGRATIONS_FOLDER`
    // where to find drizzle SQL files (the bundle inlines the code but
    // not the SQL — those land under <cli-dist>/runtime/drizzle/).
    env.COODRA_MIGRATIONS_DIR = options.migrationsDir;
  }
  if (typeof options.coodraHome === 'string' && options.coodraHome.length > 0) {
    // CRITICAL: when Claude Code spawns the MCP server via this entry, the
    // child process inherits its env from Claude Code's environment (NOT
    // from the user's shell that ran `coodra init`). Without an explicit
    // COODRA_HOME here the MCP server defaults to `~/.coodra/`, so
    // every decision/context_pack the agent records via record_decision /
    // save_context_pack lands in the user's REAL home — not the project's
    // home. The bridge writes to the configured COODRA_HOME, the MCP
    // writes to ~/.coodra: split-brain. Pin the home explicitly.
    env.COODRA_HOME = options.coodraHome;
  }
  // Phase F.6+ (2026-05-12) — pin team-mode + cloud creds in the MCP
  // child env. See option docblocks above for the rationale. Without
  // these, the child defaults to solo and every record_decision /
  // save_context_pack call skips the sync_to_cloud enqueue, leaving
  // cloud Postgres empty even though local SQLite has the rows.
  if (options.mode === 'team') {
    env.COODRA_MODE = 'team';
  }
  if (typeof options.databaseUrl === 'string' && options.databaseUrl.length > 0) {
    env.DATABASE_URL = options.databaseUrl;
  }
  if (typeof options.localHookSecret === 'string' && options.localHookSecret.length > 0) {
    env.LOCAL_HOOK_SECRET = options.localHookSecret;
  }
  if (options.agentType !== undefined) {
    env.COODRA_AGENT_TYPE = options.agentType;
  }
  return {
    command: 'node',
    args: [options.mcpServerBin, '--transport', 'stdio'],
    env,
  };
}

/** True when both entries are byte-for-byte equal under JSON canonicalisation. */
export function isCoodraEntryEqual(a: CoodraMcpEntry, b: unknown): boolean {
  if (typeof b !== 'object' || b === null) return false;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
