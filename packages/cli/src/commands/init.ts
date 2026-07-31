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
import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { resolveCoodraHome, resolveCoodraLogsDir, resolveCoodraPidsDir } from '../lib/coodra-home.js';
import { detectLanguages, detectProjectRoot } from '../lib/detect.js';
import { ensureGraphifyLlmEnvTemplate } from '../lib/graphify/env-template.js';
import type { WriteOutcome } from '../lib/init/types.js';
import { loadHomeEnv } from '../lib/load-home-env.js';
import { openLocalDb } from '../lib/open-local-db.js';
import {
  classifyGeneratedPath,
  ensureProjectLayout,
  manifestPath,
  recordManifestEntries,
  writeProjectConfig,
} from '../lib/project-store/index.js';
import { readTeamConfig } from '../lib/team-config.js';
import { upsertEnvKey } from '../lib/team-init/finalize-config.js';
import { terminalReadPrompt } from '../lib/terminal-prompt.js';
import { commandTitle, hintLine, okLine, pc, terminalWidth } from '../ui/index.js';

export interface InitOptions {
  readonly projectSlug?: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly cwd?: string;
  /** Override `~/.coodra/` location. Tests pass a tmpdir; callers default to the user's resolved home. */
  readonly home?: string;
  /**
   * Override `$HOME` for home-directory safety checks. Tests pass a tmpdir;
   * production callers omit this and the runtime defaults to `os.homedir()`.
   */
  readonly userHome?: string;
  readonly env?: NodeJS.ProcessEnv;
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
  readonly outcomes: WriteOutcome[];
  readonly dryRun: boolean;
}

/**
 * W6 / beta.6 (2026-05-14) — terminal prompt used by `runInitCommand`
 * for the team/solo question.
 * Tests inject `options.readPrompt`. 2026-07-02: now the shared
 * `lib/terminal-prompt.ts::terminalReadPrompt`.
 */
const defaultInitReadPrompt = terminalReadPrompt;

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

  const languages = await detectLanguages(root);

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
  io.writeStdout(
    `${pc.gray('·')} Project init only creates project-local .coodra state. Agent plugins are global; wire them with ${pc.cyan(
      'coodra agent add <agent>',
    )}.\n`,
  );

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
      // path of the project (where .coodra/config.json lives). The web app reads
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
        // F9 (E2E finding, 2026-07-04): if the user picked (or defaulted
        // to) a TEAM project but we could not resolve an org id, the
        // project silently registers under `__solo__` and never syncs —
        // while the earlier "Project scope: team" line implied it would.
        // Warn loudly and point at the fix instead of failing quietly.
        if (teamOrgId === undefined || teamOrgId.length === 0) {
          io.writeStdout(
            `${pc.yellow('⚠')} Could not resolve your team org id, so this project registers as ${pc.gray(
              'solo',
            )} (local-only, NOT synced to the team).\n` +
              `  ${pc.gray('→')} Run ${pc.cyan('coodra login')} to authenticate, then re-run ${pc.cyan(
                'coodra init --team',
              )} — or set ${pc.cyan('COODRA_TEAM_ORG_ID')} in ~/.coodra/.env.\n`,
          );
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

  // Phase F.6+ (2026-05-11) — reuse the daemon's LOCAL_HOOK_SECRET when
  // it already exists in ~/.coodra/.env. Otherwise plugins/hooks and
  // the daemons can drift onto different secrets and every hook event 401s.
  // Common symptom: "HTTP 401 from /v1/hooks/claude-code" in Claude Code's
  // output.
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
  // F3 (E2E finding, 2026-07-04): honour the operator's port env instead
  // of hardcoding. Pre-fix, `HOOKS_BRIDGE_PORT=39101 coodra init` still
  // wrote 3101 into project .env + the Claude Code hook URLs, so hooks
  // POSTed to the wrong bridge. A parse guard keeps the documented defaults
  // when the env var is absent or non-numeric.
  const portFromEnv = (name: string, fallback: string): string => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 && n < 65536 ? String(n) : fallback;
  };
  const mcpServerPort = portFromEnv('MCP_SERVER_PORT', '3100');
  const hooksBridgePort = portFromEnv('HOOKS_BRIDGE_PORT', '3101');

  // F1 (E2E finding, 2026-07-04): persist the resolved LOCAL_HOOK_SECRET to
  // $COODRA_HOME/.env so subsequent inits + the daemons all read the SAME
  // secret. Pre-fix nothing wrote the home .env, so every init minted a
  // fresh secret: the Claude Code hook header and the daemon's secret
  // drifted apart and every hook event 401'd (the exact symptom the reuse
  // block above tries to prevent — but the file it reads never existed).
  // Solo mode bypasses hook auth so it was masked; team / non-sentinel
  // setups hit the 401. Runtime ports live here too: Coodra-owned service
  // config belongs in ~/.coodra/.env, not the user's project .env.
  // Idempotent upsert; skipped on --dry-run.
  if (!dryRun) {
    const homeEnvPath = join(coodraHome, '.env');
    try {
      upsertEnvKey(homeEnvPath, 'LOCAL_HOOK_SECRET', localHookSecret);
      upsertEnvKey(homeEnvPath, 'MCP_SERVER_PORT', mcpServerPort);
      upsertEnvKey(homeEnvPath, 'HOOKS_BRIDGE_PORT', hooksBridgePort);
      ensureGraphifyLlmEnvTemplate(homeEnvPath);
    } catch (err) {
      io.writeStdout(
        `${pc.yellow('⚠')} Could not persist Coodra runtime config to ${homeEnvPath}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
  }

  const outcomes: WriteOutcome[] = [];

  // Write/merge the project-local `.coodra/config.json` identity.
  outcomes.push(...(await writeProjectConfig({ root, projectSlug, mode: machineCfg.mode, force, dryRun })));
  outcomes.push(...(await ensureProjectLayout(root, dryRun)));

  io.writeStdout(
    `${pc.green('✓')} Project Coodra layout ready: .coodra/recipes, .coodra/work-packs, .coodra/graphify, .coodra/wiki\n`,
  );

  // Phase 2: record every generated file into `.coodra/manifest.json` so
  // `coodra files status/clean` can show + clean up Coodra's footprint. The
  // classifier assigns owner/kind/cleanup per file; the manifest itself is
  // recorded too. Skipped writes (dry-run) don't persist a manifest.
  try {
    const globalRuntimePaths = [
      dataDb,
      join(coodraHome, '.env'),
      resolveCoodraLogsDir(coodraHome),
      resolveCoodraPidsDir(coodraHome),
    ];
    const generatedPaths = [...new Set([...outcomes.map((o) => o.path), manifestPath(root), ...globalRuntimePaths])];
    await recordManifestEntries({
      root,
      projectSlug,
      entries: generatedPaths.map((p) => classifyGeneratedPath(p, root, 'coodra init')),
      dryRun,
    });
  } catch (err) {
    io.writeStderr(`${pc.yellow('⚠')} Could not update .coodra/manifest.json: ${(err as Error).message}\n`);
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
  io.writeStdout(
    `${hintLine('  → If you have not already wired your agent, run `coodra agent add codex` or `coodra agent add claude`.')}\n`,
  );
  io.writeStdout(`${hintLine('  → Run `coodra doctor` to verify the install.')}\n`);
  io.writeStdout(`${hintLine('  → Run `coodra start` to launch the MCP server + Hooks Bridge daemons.')}\n`);

  if (dryRun) {
    io.writeStdout(`${pc.yellow('Note')}: --dry-run was set; no files were actually written.\n`);
  }

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
