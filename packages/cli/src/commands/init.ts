import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  createPostgresDb,
  ensureDefaultPolicy,
  ensureGlobalProject,
  ensureProject,
  migrateSqlite,
  postgresSchema,
} from '@coodra/db';
import { readVerifiedToken } from '@coodra/shared/auth';
import { eq } from 'drizzle-orm';
import { EXIT_ENVIRONMENT_PROBLEM, EXIT_OK, EXIT_USER_ACTION_REQUIRED, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { resolveCoodraHome, resolveCoodraLogsDir, resolveCoodraPidsDir } from '../lib/coodra-home.js';
import { detectIDE, detectLanguages, detectProjectRoot, resolveIdeSelection } from '../lib/detect.js';
import { defaultClaudeSettingsPath, mergeClaudeSettings } from '../lib/init/claude-settings-merge.js';
import { mergeCodexConfig } from '../lib/init/codex-merge.js';
import { writeCoodraJson } from '../lib/init/coodra-json.js';
import { mergeCursorMcpConfig } from '../lib/init/cursor-merge.js';
import { type BaselineEnv, mergeEnvFile } from '../lib/init/env-merge.js';
import { seedFeaturePack } from '../lib/init/feature-pack-seed.js';
import { seedGraphifySeedPacksFeature } from '../lib/init/graphify-feature.js';
import { DEFAULT_GRAPHIFY_GRAPH_PATH, DEFAULT_GRAPHIFY_PYTHON, wireGraphify } from '../lib/init/graphify-wire.js';
import { mergeInstructionFile } from '../lib/init/instruction-files.js';
import { buildCoodraMcpEntry, mergeMcpJson } from '../lib/init/mcp-merge.js';
import type { WriteOutcome } from '../lib/init/types.js';
import { mergeWindsurfMcpConfig } from '../lib/init/windsurf-merge.js';
import { loadHomeEnv } from '../lib/load-home-env.js';
import { openLocalDb } from '../lib/open-local-db.js';
import { bundledMigrationsDir, resolveRuntimeBinary } from '../lib/runtime-paths.js';
import { readTeamConfig } from '../lib/team-config.js';
import { listAvailableTemplates, resolveTemplatePath } from '../lib/template-paths.js';
import { detectTemplate } from '../lib/templates/detect.js';
import { loadTemplate, type TemplateDefinition, TemplateLoadError } from '../lib/templates/load-template.js';
import { commandTitle, hintLine, okLine, pc, terminalWidth } from '../ui/index.js';

export interface InitOptions {
  readonly projectSlug?: string;
  readonly ide?: string;
  readonly graphify?: boolean;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly cwd?: string;
  /** Override `~/.coodra/` location. Tests pass a tmpdir; callers default to the user's resolved home. */
  readonly home?: string;
  /**
   * Override `$HOME` for IDE detection AND for `~/.claude/settings.json`
   * resolution. Tests pass a tmpdir to avoid touching the runner's
   * real ~/.claude/. Production callers omit this and the runtime
   * defaults to `os.homedir()`.
   */
  readonly userHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Module 08b S13: feature-pack template selector. Bare name resolves
   * via `resolveTemplatePath` (user-installed → bundled). A path
   * (absolute, relative, or with `/`) loads from disk directly.
   * `--template auto` triggers project detection.
   */
  readonly template?: string;
  /**
   * Module 08b S13: `minimal` (default; legacy skeleton output),
   * `default` (template-driven output), `auto` (detect + render).
   * `--mode auto` implies `--template auto` if --template is omitted.
   * The auto-section population pass lands in M08b S15.
   */
  readonly mode?: string;
  /**
   * 2026-05-08 — controls whether `init` writes the four-file template
   * stub into `<root>/docs/feature-packs/<slug>/`. See
   * `FeaturePackSeedMode` in `lib/init/feature-pack-seed.ts` for the
   * semantics.
   *
   *   `template` (default) — render the 4 canonical files (today's behaviour)
   *   `empty`              — create the folder + .gitkeep only
   *   `skip`               — don't create the folder
   *
   * Commander accepts `--feature-pack <mode>` AND the boolean negation
   * `--no-feature-pack` (which maps to `skip` in the runner).
   */
  readonly featurePack?: string;
  /**
   * W6 / beta.6 (2026-05-14) — project org scope selection on a
   * team-capable machine.
   *
   *   `--team` → register this project under the machine's Clerk org
   *              (syncs to cloud, visible to teammates). Default on a
   *              team machine.
   *   `--solo` → register this project as local-only (`org_id=__solo__`,
   *              never synced) even though the machine is in team mode.
   *              Lets a team member keep private / scratch projects.
   *
   * Mutually exclusive. On a solo machine both are ignored (everything
   * is solo). When neither is set on a team machine AND stdin is a TTY,
   * `init` prompts; non-interactive callers default to `team` with a
   * printed notice (preserves pre-beta.6 scripted behaviour).
   *
   * Test surface: `readPrompt` overrides stdin so unit tests drive the
   * selection without a real terminal.
   */
  readonly solo?: boolean;
  readonly team?: boolean;
  readonly readPrompt?: (prompt: string) => Promise<string>;
}

export interface InitIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_INIT_IO: InitIO = {
  writeStdout: (chunk) => {
    process.stdout.write(chunk);
  },
  writeStderr: (chunk) => {
    process.stderr.write(chunk);
  },
  exit: (code) => {
    process.exit(code);
  },
};

export interface InitReport {
  readonly projectRoot: string;
  readonly coodraHome: string;
  readonly projectSlug: string;
  readonly languages: string[];
  readonly ides: string[];
  readonly outcomes: WriteOutcome[];
  readonly dryRun: boolean;
}

/**
 * W6 / beta.6 (2026-05-14) — terminal prompt used by `runInitCommand`
 * to ask "team or solo project?" on a team-capable machine. Mirrors
 * `team-init.ts::defaultReadPrompt`. Tests inject `options.readPrompt`.
 */
async function defaultInitReadPrompt(prompt: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

export async function runInitCommand(options: InitOptions = {}, io: InitIO = DEFAULT_INIT_IO): Promise<never> {
  const env = options.env ?? process.env;
  const dryRun = options.dryRun === true;
  const force = options.force === true;

  // W6 / beta.6 — `--solo` / `--team` are mutually exclusive.
  if (options.solo === true && options.team === true) {
    io.writeStderr(`${pc.red('coodra init')}: --solo and --team are mutually exclusive — pass at most one.\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  const cwd = resolve(options.cwd ?? process.cwd());
  const userHomeForDetection = options.userHome ?? homedir();
  const detection = await detectProjectRoot(cwd, { homeDir: userHomeForDetection });
  if (detection.markers.length === 0 && detection.skippedHomeMatch === undefined) {
    io.writeStderr(
      `${pc.red('coodra init')}: no project root marker found near ${cwd}. ` +
        'Run init from a directory that contains package.json, pyproject.toml, Cargo.toml, or .git.\n',
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }
  // When the only walk-up match was $HOME (e.g. ~/.git from a dotfiles
  // repo), we don't want to splat the project files into the user's
  // home. detectProjectRoot rejected the home match and returned cwd
  // as the fallback root. Surface that clearly — the user typed
  // `coodra init` from `~/myproject` and expects it to work there,
  // not silently treat `~` as the project.
  const root = detection.root;
  if (detection.skippedHomeMatch !== undefined) {
    const m = detection.skippedHomeMatch;
    io.writeStdout(
      `${pc.yellow('⚠')} Found ${m.markers.join(', ')} in ${m.homeDir} — that's your home directory, not a project. ` +
        `Using ${pc.cyan(root)} as the project root instead.\n`,
    );
    if (detection.markers.length === 0) {
      io.writeStdout(
        `  ${pc.gray('→')} ${pc.gray(`Tip: add a marker to ${root} (e.g. \`git init\` or a package.json) so future runs detect it automatically.`)}\n`,
      );
    }
  }
  const projectSlug = sanitizeSlug(options.projectSlug ?? basename(root));
  if (projectSlug.length === 0) {
    io.writeStderr(`${pc.red('coodra init')}: could not derive a usable project slug from ${root}.\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  io.writeStdout(`${commandTitle('Initialise', `Coodra · ${projectSlug}`, { width: terminalWidth(), indent: 0 })}\n`);

  const userHome = options.userHome ?? homedir();
  const languages = await detectLanguages(root);
  const detectedIdes = await detectIDE({ homeDir: userHome });
  const ideSelection = resolveIdeSelection({ flag: options.ide, detected: detectedIdes });
  if (!ideSelection.ok) {
    io.writeStderr(`${pc.red('coodra init')}: ${ideSelection.error}\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }
  const ides = ideSelection.ides;

  // Phase D (clarity-pass-plan, 2026-05-11) — surface the machine's
  // mode in the first lines of `coodra init` output. Projects
  // don't have a mode; machines do. A project inherits the machine's
  // mode at init time and gets stamped with the team's org_id if the
  // machine is in team mode. Making this explicit at init eliminates
  // the "wait, am I solo or team?" surprise from later workflows.
  const machineHome = resolveCoodraHome({
    ...(options.home !== undefined ? { override: options.home } : {}),
    env,
  });
  const machineCfg = readTeamConfig({ homeOverride: machineHome });
  const machineModeLabel = machineCfg.mode === 'team' ? pc.cyan('team') : pc.gray('solo');
  const machineOrgSuffix =
    machineCfg.mode === 'team' && machineCfg.team !== undefined
      ? `  (org ${machineCfg.team.clerkOrgSlug ?? `${machineCfg.team.clerkOrgId.slice(0, 12)}…`})`
      : '';
  io.writeStdout(`${pc.bold('Machine mode')}: ${machineModeLabel}${machineOrgSuffix}\n`);

  // W6 / beta.6 (2026-05-14) — project org-scope selection. The MACHINE
  // has a mode (solo | team); each PROJECT independently chooses whether
  // to register under the machine's team org (syncs to cloud, visible
  // to teammates) or stay local-only (`org_id=__solo__`, never synced).
  //
  // Pre-beta.6 `init` silently inherited the machine mode — a team-mode
  // laptop made *every* project a team project with no prompt, which
  // surprised users who wanted a private scratch project. Now:
  //   - solo machine          → always solo (no choice exists).
  //   - team machine + --solo → solo project.
  //   - team machine + --team → team project.
  //   - team machine, neither flag, interactive TTY → prompt (default team).
  //   - team machine, neither flag, non-interactive → team + notice
  //     (preserves pre-beta.6 scripted behaviour).
  let registerAsTeamProject = false;
  if (machineCfg.mode === 'team') {
    if (options.solo === true) {
      registerAsTeamProject = false;
      io.writeStdout(
        `${pc.gray('·')} Project scope: ${pc.gray('solo')} (--solo) — local-only, never synced to the team.\n`,
      );
    } else if (options.team === true) {
      registerAsTeamProject = true;
      io.writeStdout(`${pc.green('✓')} Project scope: ${pc.cyan('team')} (--team) — syncs to the team org.\n`);
    } else {
      const readPrompt = options.readPrompt ?? defaultInitReadPrompt;
      const interactive = options.readPrompt !== undefined || process.stdin.isTTY === true;
      if (interactive) {
        const orgLabel =
          machineCfg.team !== undefined ? (machineCfg.team.clerkOrgSlug ?? machineCfg.team.clerkOrgId) : 'your team';
        io.writeStdout(
          `\n${pc.bold('Register this project as:')}\n` +
            `  ${pc.cyan('[T]')} team  — syncs to org ${pc.cyan(orgLabel)}; teammates see its features/decisions/runs\n` +
            `  ${pc.gray('[s]')} solo  — local-only on this machine; never synced\n`,
        );
        const answer = (await readPrompt(`  Choice [${pc.cyan('T')}/s]: `)).trim().toLowerCase();
        registerAsTeamProject = answer !== 's' && answer !== 'solo';
        io.writeStdout(
          registerAsTeamProject
            ? `${pc.green('✓')} Project scope: ${pc.cyan('team')}\n`
            : `${pc.gray('·')} Project scope: ${pc.gray('solo')} — local-only.\n`,
        );
      } else {
        registerAsTeamProject = true;
        io.writeStdout(
          `${pc.gray('·')} Project scope: ${pc.cyan('team')} (default; non-interactive). ` +
            `Pass ${pc.cyan('--solo')} to keep a project local-only.\n`,
        );
      }
    }
  }

  io.writeStdout(`${pc.green('✓')} Detected project root: ${root}\n`);
  if (detection.markers.includes('.git')) {
    io.writeStdout(`${pc.green('✓')} Detected git repo at ${root}\n`);
  }
  if (languages.length > 0) {
    io.writeStdout(`${pc.green('✓')} Detected languages: ${languages.join(', ')}\n`);
  }
  if (detectedIdes.length > 0) {
    io.writeStdout(`${pc.green('✓')} Detected IDEs: ${detectedIdes.join(', ')}\n`);
  } else {
    io.writeStdout(`${pc.yellow('⚠')} No IDE config dir (~/.claude, ~/.cursor, ~/.windsurf, ~/.codex) detected.\n`);
  }
  if (options.ide !== undefined) {
    if (ides.length === 0) {
      io.writeStdout(`${pc.yellow('⚠')} --ide ${options.ide}: empty selection — no IDE will be wired.\n`);
    } else {
      io.writeStdout(`${pc.green('✓')} --ide ${options.ide}: wiring ${ides.join(', ')} (overrides detection).\n`);
    }
  } else if (ides.length === 0) {
    io.writeStdout(
      `  ${pc.gray('→')} ${pc.gray('No IDEs to wire. Install Claude Code, Cursor, Windsurf, or Codex CLI, then re-run `coodra init`.')}\n`,
    );
  }

  // Resolve and create ~/.coodra/{logs,pids} (data.db is created by openLocalDb).
  const coodraHome = resolveCoodraHome({
    ...(options.home !== undefined ? { override: options.home } : {}),
    env,
  });
  if (!dryRun) {
    // First make sure the home root itself is 0700. `mkdir { mode }`
    // only sets perms on directories it actually creates; if the
    // operator pre-created `~/.coodra` (e.g. via `mkdir -p`), perms
    // stay at the umask default (typically 0755) and doctor check 2
    // flags it. Explicitly chmod brings it into compliance whether
    // it's new or pre-existing. (Demo finding 2026-05-11.)
    await mkdir(coodraHome, { recursive: true, mode: 0o700 });
    try {
      await chmod(coodraHome, 0o700);
    } catch {
      // chmod can fail on Windows or when the user lacks ownership.
      // We don't escalate — doctor check 2 will surface a yellow with
      // the actual remediation.
    }
    await mkdir(resolveCoodraLogsDir(coodraHome), { recursive: true, mode: 0o700 });
    await mkdir(resolveCoodraPidsDir(coodraHome), { recursive: true, mode: 0o700 });
  }
  io.writeStdout(`${pc.green('✓')} Resolved Coodra home: ${coodraHome}\n`);

  // M04 Phase 4 / Phase G+H verification: layer ~/.coodra/.env into
  // process.env so that `ensureProject` (and any other helper that reads
  // `process.env.COODRA_MODE`) sees `team` after `team setup` ran.
  // Without this the team-mode sync_to_cloud enqueue for the projects
  // row never fires from init, cloud Postgres never gets the row, and
  // every downstream runs/decisions push hits an FK violation.
  const homeLayered = loadHomeEnv(coodraHome, root);
  for (const [key, value] of Object.entries(homeLayered)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  // Apply migrations + seed F7 sentinel + register the user's project +
  // seed default policy rules (Phase 3 Fix D, 2026-05-02 — pre-Phase-3
  // init created the project but inserted zero rules; the evaluator
  // returned 'allow' for everything because no rule ever matched, so
  // every fresh install shipped with policy enforcement effectively
  // off).
  const dataDb = `${coodraHome}/data.db`;
  if (!dryRun) {
    const handle = await openLocalDb(dataDb, { loadVecExtension: true });
    try {
      migrateSqlite(handle.db);
      await ensureGlobalProject(handle);
      // Pass `cwd: root` so the projects row records the absolute filesystem
      // path of the project (where .coodra.json lives). The web app reads
      // this back to write per-project pack uploads into the correct folder
      // — see `apps/web-v2/lib/queries/packs.ts:packsRoot()`.
      //
      // In team mode, also pass the team's Clerk org id so the projects
      // row carries the correct org affiliation. Without this, init would
      // default to `__solo__` even after `team setup` set up the team
      // config, and the cloud-side `org_id` column would split the project
      // off from the rest of the org's data.
      //
      // Phase H.2 — prefer the verified Clerk JWT mirror's orgId over the
      // env var. The env var is overrideable by anything that can write
      // `~/.coodra/.env`; the verified token mirror is bound to a
      // valid Clerk signature. They should agree, but on disagreement
      // the JWT mirror wins (it's the source of truth for who-is-acting).
      //
      // W6 / beta.6 — the team-org resolution is now gated on
      // `registerAsTeamProject` (the solo/team choice made above). On a
      // team machine where the user picked "solo" for THIS project,
      // `teamOrgId` stays undefined → `ensureProject` defaults to
      // `__solo__` → the project is local-only even though the machine
      // is team mode.
      let teamOrgId: string | undefined;
      if (process.env.COODRA_MODE === 'team' && registerAsTeamProject) {
        try {
          const verified = await readVerifiedToken({ homeOverride: coodraHome });
          if (verified !== null && verified.orgId.length > 0) {
            teamOrgId = verified.orgId;
          }
        } catch {
          // Verifier may fail at boot if CLERK_PUBLISHABLE_KEY isn't yet
          // layered into process.env. Fall back to the env var.
        }
        if (teamOrgId === undefined) {
          teamOrgId = process.env.COODRA_TEAM_ORG_ID;
        }
      }

      // Team-mode slug-adoption (M04 Phase 4 / split-brain fix):
      // when another teammate has already registered this slug, cloud
      // Postgres has the canonical id. If we mint a fresh local UUID
      // here, the daemon's first push hits a unique-on-slug FK
      // violation and the row is stuck forever. Instead, query cloud
      // for the slug; if found, adopt that id locally. ensureProject's
      // existing `idOverride` arg handles the cloud-supplied id.
      //
      // W6 / beta.6 — also gated on `registerAsTeamProject`: a solo
      // project on a team machine must NOT adopt a cloud id (it never
      // syncs, so there's no split-brain to avoid, and adopting a
      // team-canonical id for a local-only project is wrong).
      let cloudIdHint: string | undefined;
      const databaseUrl = process.env.DATABASE_URL;
      if (
        process.env.COODRA_MODE === 'team' &&
        registerAsTeamProject &&
        databaseUrl !== undefined &&
        databaseUrl.length > 0
      ) {
        try {
          const cloudHandle = createPostgresDb({ databaseUrl });
          try {
            const existing = await cloudHandle.db
              .select({ id: postgresSchema.projects.id })
              .from(postgresSchema.projects)
              .where(eq(postgresSchema.projects.slug, projectSlug))
              .limit(1);
            if (existing[0] !== undefined) {
              cloudIdHint = existing[0].id;
              io.writeStdout(
                `${pc.cyan('ℹ')} Cloud already has project '${projectSlug}' — adopting team-canonical id ${cloudIdHint}\n`,
              );
            }
          } finally {
            await cloudHandle.close();
          }
        } catch (err) {
          // Cloud unreachable — proceed with a fresh local id and
          // accept the risk of split-brain. Doctor will flag the FK
          // failure once the daemon comes online.
          io.writeStdout(
            `${pc.yellow('⚠')} Could not query cloud for existing slug — proceeding with a fresh id ` +
              `(if a teammate has already registered '${projectSlug}', re-run init once cloud is reachable). ` +
              `Cause: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }

      const projectResult = await ensureProject(handle, {
        slug: projectSlug,
        cwd: root,
        ...(teamOrgId !== undefined && teamOrgId.length > 0 ? { orgId: teamOrgId } : {}),
        ...(cloudIdHint !== undefined ? { idOverride: cloudIdHint } : {}),
      });
      const policyResult = await ensureDefaultPolicy(handle, projectResult.id);
      io.writeStdout(
        `${pc.green('✓')} Applied migrations + seeded __global__ + registered project '${projectSlug}' ` +
          `(${projectResult.created ? 'new' : 'existing'} id ${projectResult.id})\n`,
      );
      if (policyResult.created) {
        io.writeStdout(
          `${pc.green('✓')} Seeded default policy with ${policyResult.rulesInserted} baseline rules ` +
            '(deny .env / .git/** / node_modules/** writes; ask before Bash)\n',
        );
      } else {
        io.writeStdout(`${pc.gray('=')} Default policy already present — leaving user customizations intact\n`);
      }
    } finally {
      handle.close();
    }
  } else {
    io.writeStdout(`${pc.yellow('⚠')} Dry run: skipping migrations + sentinel seed\n`);
  }

  // Resolve the bundled mcp-server binary path. dec_83ba10c1
  // (2026-05-02) made this a hard requirement — pre-decision the npm-
  // installed path silently fell back to a `npx … mcp-stdio` invocation
  // that pointed at a subcommand that did not exist. Now we either
  // resolve a real path or fail loudly with a remediation message.
  let mcpServerBin: string;
  try {
    const resolved = await resolveRuntimeBinary('mcp-server');
    mcpServerBin = resolved.path;
    io.writeStdout(`${pc.green('✓')} Resolved mcp-server runtime: ${resolved.source} (${resolved.path})\n`);
  } catch (err) {
    io.writeStderr(`${pc.red('coodra init')}: ${(err as Error).message}\n`);
    return io.exit(EXIT_ENVIRONMENT_PROBLEM);
  }
  const bundledMigrations = bundledMigrationsDir('sqlite');
  // Strip the dialect suffix so the env var conveys the parent dir
  // (`@coodra/db::MIGRATIONS_FOLDER` re-appends the dialect). Empty
  // when the resolver returned null (workspace dev mode) — the bundled
  // mcp-server falls through to its package-relative default.
  const migrationsDir =
    bundledMigrations !== null ? bundledMigrations.replace(/\/sqlite$/, '').replace(/\\sqlite$/, '') : null;

  // Phase F.6+ (2026-05-11) — reuse the daemon's LOCAL_HOOK_SECRET when
  // it already exists in ~/.coodra/.env. Otherwise Claude Code reads
  // the project-level secret (which init randomly generated) but the
  // daemons read the home-level one, the secrets don't match, and every
  // hook event 401s. Common symptom: "HTTP 401 from /v1/hooks/claude-code"
  // in Claude Code's output.
  //
  // Resolution: try the daemon's existing secret first; fall back to a
  // fresh random one only for the very first init on this machine.
  let localHookSecret: string;
  try {
    const homeEnvPath = join(coodraHome, '.env');
    const homeRaw = await readFile(homeEnvPath, 'utf8');
    const match = homeRaw.match(/^LOCAL_HOOK_SECRET=(\S+)/m);
    localHookSecret = match?.[1] ?? randomBytes(32).toString('hex');
  } catch {
    localHookSecret = randomBytes(32).toString('hex');
  }
  const baselineEnv: BaselineEnv = {
    // Module 04 Phase 4 H6 — COODRA_MODE intentionally omitted. See
    // BaselineEnv type comment for the full reason. tldr: project .env
    // wins over home .env in `loadHomeEnv`, so writing 'solo' here
    // would override `team setup`'s home-level COODRA_MODE=team.
    CLERK_SECRET_KEY: 'sk_test_replace_me',
    CLERK_PUBLISHABLE_KEY: 'pk_test_replace_me',
    LOCAL_HOOK_SECRET: localHookSecret,
    MCP_SERVER_PORT: '3100',
    HOOKS_BRIDGE_PORT: '3101',
  };

  const outcomes: WriteOutcome[] = [];

  // Write/merge .coodra.json
  outcomes.push(await writeCoodraJson({ cwd: root, projectSlug, force, dryRun }));

  // Write/merge .mcp.json with the canonical coodra entry. Pin
  // COODRA_HOME so the Claude-Code-spawned MCP server reads/writes
  // the same SQLite the bridge does — without this, MCP tool calls
  // (record_decision, save_context_pack) land in the user's default
  // ~/.coodra/data.db while the bridge writes to the project home.
  // Phase F.6+ (2026-05-12) — pin team-mode + DATABASE_URL into the MCP
  // child env so Claude Code's spawned MCP server enqueues sync_to_cloud
  // jobs on record_decision / save_context_pack writes. Without this,
  // the child defaults to solo because it inherits Claude's shell env
  // (which doesn't auto-load ~/.coodra/.env). Result pre-fix: cloud
  // Postgres stays empty for decisions/packs even though local SQLite
  // has the rows — web /decisions and /context-packs render empty.
  const machineDatabaseUrl =
    machineCfg.mode === 'team' && machineCfg.team !== undefined ? process.env.DATABASE_URL : undefined;
  const mcpEntry = buildCoodraMcpEntry({
    mcpServerBin,
    clerkSecretKey: baselineEnv.CLERK_SECRET_KEY,
    migrationsDir,
    coodraHome,
    mode: machineCfg.mode,
    ...(typeof machineDatabaseUrl === 'string' && machineDatabaseUrl.length > 0
      ? { databaseUrl: machineDatabaseUrl }
      : {}),
    localHookSecret,
  });
  outcomes.push(await mergeMcpJson({ cwd: root, entry: mcpEntry, force, dryRun }));

  // Write/merge .env with solo-mode sentinels
  outcomes.push(await mergeEnvFile({ cwd: root, baseline: baselineEnv, force, dryRun }));

  // Per-agent wiring — gated on the resolved `ides` list (detection or
  // explicit `--ide`). Each agent gets two pieces:
  //   1. MCP config — tells the agent how to spawn the bundled coodra
  //      MCP server (the 26 `coodra__*` tools).
  //   2. Instruction file — the trigger contract telling the agent
  //      WHEN to call which tool. Same marker-wrapped block per agent.
  //
  // Claude Code additionally gets hook entries in `~/.claude/settings.json`
  // so the bridge can inject runtime `additionalContext` at SessionStart
  // and auto-save Context Packs at SessionEnd (decision dec_83ba10c1).
  // CLAUDE.md is defense-in-depth: works even if the bridge isn't running.
  //
  // Every writer is idempotent + reversed by `coodra uninstall`. The
  // `--ide` flag overrides detection — see resolveIdeSelection.

  if (ides.includes('claude')) {
    try {
      const claudeMerge = await mergeClaudeSettings({
        settingsPath: defaultClaudeSettingsPath(userHome),
        bridgePort: Number(baselineEnv.HOOKS_BRIDGE_PORT),
        // Phase F.6+ — inline the literal secret so Claude Code's hook
        // sends the correct X-Local-Hook-Secret header regardless of
        // shell env state. See ClaudeSettingsMergeOptions docblock.
        localHookSecret: localHookSecret,
        force,
        dryRun,
      });
      outcomes.push(claudeMerge.outcome);
      outcomes.push(await mergeInstructionFile({ cwd: root, filename: 'CLAUDE.md', projectSlug, dryRun }));
    } catch (err) {
      io.writeStderr(`${pc.yellow('⚠')} Could not wire Claude integration: ${(err as Error).message}\n`);
    }
  }
  if (ides.includes('cursor')) {
    try {
      outcomes.push(await mergeCursorMcpConfig({ cwd: root, entry: mcpEntry, force, dryRun }));
      outcomes.push(await mergeInstructionFile({ cwd: root, filename: '.cursorrules', projectSlug, dryRun }));
    } catch (err) {
      io.writeStderr(`${pc.yellow('⚠')} Could not wire Cursor integration: ${(err as Error).message}\n`);
    }
  }
  if (ides.includes('codex')) {
    try {
      outcomes.push(await mergeCodexConfig({ cwd: root, entry: mcpEntry, force, dryRun }));
      outcomes.push(await mergeInstructionFile({ cwd: root, filename: 'AGENTS.md', projectSlug, dryRun }));
    } catch (err) {
      io.writeStderr(`${pc.yellow('⚠')} Could not wire Codex integration: ${(err as Error).message}\n`);
    }
  }
  if (ides.includes('windsurf')) {
    try {
      outcomes.push(await mergeWindsurfMcpConfig({ entry: mcpEntry, force, dryRun, userHome }));
      outcomes.push(await mergeInstructionFile({ cwd: root, filename: '.windsurfrules', projectSlug, dryRun }));
    } catch (err) {
      io.writeStderr(`${pc.yellow('⚠')} Could not wire Windsurf integration: ${(err as Error).message}\n`);
    }
  }

  // Module 08b S13: resolve --template (and --mode auto) to a
  // TemplateDefinition before seeding. Three paths:
  //   - --template <path>  → load directly from disk
  //   - --template <name>  → resolve via user-installed → bundled
  //   - --mode auto + no --template → detect from project root
  // Failures are surfaced as warnings + we fall through to the legacy
  // skeleton path. The S15 follow-up adds auto-section population on
  // top of the rendered template.
  let template: TemplateDefinition | undefined;
  const templateSelector =
    options.template !== undefined && options.template.length > 0
      ? options.template
      : options.mode === 'auto'
        ? 'auto'
        : undefined;
  if (templateSelector !== undefined && templateSelector !== 'auto') {
    const resolved = resolveTemplatePath(templateSelector, { cwd: root });
    if (resolved === null) {
      io.writeStderr(
        `${pc.yellow('⚠')} --template "${templateSelector}" not found (user templates: ~/.coodra/templates/, bundled: cli-dist/templates/). Falling back to skeleton.\n`,
      );
    } else {
      try {
        template = await loadTemplate(resolved.dir);
        io.writeStdout(`${pc.green('✓')} Using template "${template.meta.name}" (source: ${resolved.source}).\n`);
      } catch (err) {
        const message = err instanceof TemplateLoadError ? err.message : (err as Error).message;
        io.writeStderr(
          `${pc.yellow('⚠')} Could not load template "${templateSelector}": ${message}. Falling back to skeleton.\n`,
        );
      }
    }
  } else if (templateSelector === 'auto') {
    // Detect from project root.
    const all = listAvailableTemplates();
    const definitions: TemplateDefinition[] = [];
    for (const t of all) {
      try {
        definitions.push(await loadTemplate(t.dir));
      } catch {
        // skip unloadable templates
      }
    }
    // Sort: more-specific first; generic last.
    const sorted = [...definitions].sort((a, b) => {
      if (a.meta.name === 'generic') return 1;
      if (b.meta.name === 'generic') return -1;
      return a.meta.name.localeCompare(b.meta.name);
    });
    const detected = detectTemplate(root, sorted);
    if (detected.chosen !== null) {
      template = detected.chosen;
      io.writeStdout(`${pc.green('✓')} --mode auto detected template "${template.meta.name}".\n`);
    } else {
      io.writeStderr(`${pc.yellow('⚠')} --mode auto could not detect a template; falling back to skeleton.\n`);
    }
  }

  // Seed the feature pack folder. Module 08b S15: when --mode auto AND
  // a template was resolved, also auto-populate the template's
  // <!-- @auto:* --> sections from project shape (deps, directory tree,
  // scripts, entry points).
  const autoPopulate = options.mode === 'auto' && template !== undefined;

  // 2026-05-08 — Resolve `--feature-pack <mode>` (and the Commander
  // boolean negation `--no-feature-pack` which arrives as `false`)
  // into the canonical FeaturePackSeedMode. Anything unrecognised
  // falls back to 'template' (today's behaviour) with a warning so
  // typos are surfaced rather than silently downgrading the user's
  // intent.
  const featurePackMode = resolveFeaturePackMode(options.featurePack, io);
  if (featurePackMode === 'empty') {
    io.writeStdout(
      `${pc.green('✓')} --feature-pack=empty: creating an empty feature-pack folder; populate via web upload or your own .md files.\n`,
    );
  } else if (featurePackMode === 'skip') {
    io.writeStdout(`${pc.green('✓')} --feature-pack=skip: not seeding any feature-pack folder.\n`);
  }

  const seedOutcomes = await seedFeaturePack({
    cwd: root,
    slug: projectSlug,
    languages,
    force,
    dryRun,
    ...(template !== undefined ? { template } : {}),
    autoPopulate,
    featurePack: featurePackMode,
  });
  outcomes.push(...seedOutcomes);
  if (autoPopulate && template !== undefined && featurePackMode === 'template') {
    io.writeStdout(
      `${pc.green('✓')} Auto-populated ${template.meta.autoSections.length} <!-- @auto:* --> section(s) from project shape.\n`,
    );
  }

  // Module 09 (Track 9B, ADR-010) — optional Graphify wiring. Graphify
  // ships its own stdio MCP server; when the user opts in, `init` wires
  // it next to the `coodra` entry in each agent config and seeds the
  // `graphify-seed-packs` skill. Graphify is NOT wired by default — it
  // needs a separate install (`graphifyy[mcp]`) plus a built graph, so
  // a blind wire would point at a server that isn't there.
  //   --graphify     → wire it (no prompt)
  //   --no-graphify  → skip it (no prompt)
  //   neither + TTY  → prompt (default: skip)
  //   neither, non-interactive → skip with a hint
  let wireGraphifyChoice: boolean;
  if (options.graphify === true) {
    wireGraphifyChoice = true;
  } else if (options.graphify === false) {
    wireGraphifyChoice = false;
  } else if (ides.length === 0) {
    // No agent config to wire into — nothing to ask.
    wireGraphifyChoice = false;
  } else {
    const graphifyReadPrompt = options.readPrompt ?? defaultInitReadPrompt;
    const graphifyInteractive = options.readPrompt !== undefined || process.stdin.isTTY === true;
    if (graphifyInteractive) {
      io.writeStdout(
        `\n${pc.bold('Wire Graphify?')} ${pc.gray('— Graphify builds a codebase knowledge graph and ships its own MCP server.')}\n` +
          `  ${pc.gray('Needs `graphifyy[mcp]` installed + a built graph. Skip if unsure — `coodra graphify enable` adds it any time.')}\n`,
      );
      const answer = (await graphifyReadPrompt(`  Wire Graphify's MCP server? [${pc.cyan('y')}/${pc.cyan('N')}]: `))
        .trim()
        .toLowerCase();
      wireGraphifyChoice = answer === 'y' || answer === 'yes';
    } else {
      wireGraphifyChoice = false;
    }
  }

  if (wireGraphifyChoice && ides.length > 0) {
    for (const ide of ides) {
      try {
        outcomes.push(
          await wireGraphify({
            ide,
            cwd: root,
            userHome,
            python: DEFAULT_GRAPHIFY_PYTHON,
            graphPath: DEFAULT_GRAPHIFY_GRAPH_PATH,
            force,
            dryRun,
          }),
        );
      } catch (err) {
        io.writeStderr(`${pc.yellow('⚠')} Could not wire Graphify for ${ide}: ${(err as Error).message}\n`);
      }
    }
    try {
      outcomes.push(await seedGraphifySeedPacksFeature({ cwd: root, projectSlug, force, dryRun }));
    } catch (err) {
      io.writeStderr(`${pc.yellow('⚠')} Could not seed the graphify-seed-packs skill: ${(err as Error).message}\n`);
    }
    io.writeStdout(
      `${pc.green('✓')} Wired Graphify's MCP server + seeded the graphify-seed-packs skill. ` +
        'Install it (`uv tool install graphifyy`) and run `/graphify .` to build the graph.\n',
    );
  } else if (options.graphify === false) {
    io.writeStdout(`${pc.gray('·')} Skipped Graphify wiring (--no-graphify).\n`);
  } else {
    io.writeStdout(
      `${pc.gray('·')} Graphify not wired. Run \`coodra graphify enable\` any time to add its codebase-graph MCP server.\n`,
    );
  }

  io.writeStdout('\n');
  io.writeStdout(`${pc.bold('Files written')}\n`);
  for (const outcome of outcomes) {
    const glyph = actionGlyph(outcome.action);
    const note = outcome.notes !== undefined ? pc.gray(` (${outcome.notes})`) : '';
    io.writeStdout(`  ${glyph} ${outcome.path}${note}\n`);
  }

  io.writeStdout('\n');
  io.writeStdout(`${okLine(`Coodra is ready — project '${projectSlug}'.`)}\n`);
  io.writeStdout(`${hintLine('  → Restart your IDE so it picks up .mcp.json.')}\n`);
  io.writeStdout(`${hintLine('  → Run `coodra doctor` to verify the install.')}\n`);
  io.writeStdout(`${hintLine('  → Run `coodra start` to launch the MCP server + Hooks Bridge daemons.')}\n`);

  if (dryRun) {
    io.writeStdout(`${pc.yellow('Note')}: --dry-run was set; no files were actually written.\n`);
  }

  // No critical reds during init under happy path. Future expansions (e.g.,
  // Graphify error) may surface EXIT_ENVIRONMENT_PROBLEM or
  // EXIT_USER_ACTION_REQUIRED; those constants are imported here so a future
  // slice doesn't have to re-thread them.
  void EXIT_ENVIRONMENT_PROBLEM;
  void EXIT_USER_ACTION_REQUIRED;
  return io.exit(EXIT_OK);
}

function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function actionGlyph(action: string): string {
  switch (action) {
    case 'wrote':
      return pc.green('+');
    case 'merged':
      return pc.green('~');
    case 'forced':
      return pc.yellow('!');
    case 'unchanged':
      return pc.gray('=');
    default:
      return pc.gray('?');
  }
}

/**
 * Map the raw `--feature-pack` value (or the boolean `--no-feature-pack`
 * negation, which arrives from Commander as `false`) into the canonical
 * `FeaturePackSeedMode`.
 *
 * Accepts:
 *   - `undefined`           → `'template'` (default; matches pre-2026-05-08 behaviour)
 *   - `'template'`          → `'template'`
 *   - `'empty'`             → `'empty'`
 *   - `'skip'` / `false`    → `'skip'` (Commander emits `false` for `--no-feature-pack`)
 *
 * Anything else is a typo — warn and fall back to `'template'` so a
 * stale shell completion or fat-finger doesn't silently change behaviour.
 */
function resolveFeaturePackMode(raw: string | undefined, io: InitIO): 'template' | 'empty' | 'skip' {
  // Commander turns `--no-feature-pack` into a `false` boolean on the
  // options bag. The TypeScript type widens to string for callers that
  // pass a value, but at runtime we accept either.
  if ((raw as unknown) === false) return 'skip';
  if (raw === undefined) return 'template';
  if (raw === 'template' || raw === 'empty' || raw === 'skip') return raw;
  io.writeStderr(
    `${pc.yellow('⚠')} Unknown --feature-pack mode "${raw}" (expected: template, empty, skip). Falling back to "template".\n`,
  );
  return 'template';
}
