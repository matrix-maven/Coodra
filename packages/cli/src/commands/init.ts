import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { ensureDefaultPolicy, ensureGlobalProject, ensureProject, migrateSqlite } from '@coodra/contextos-db';
import pc from 'picocolors';
import { EXIT_ENVIRONMENT_PROBLEM, EXIT_OK, EXIT_USER_ACTION_REQUIRED, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { resolveContextosHome, resolveContextosLogsDir, resolveContextosPidsDir } from '../lib/contextos-home.js';
import { detectIDE, detectLanguages, detectProjectRoot } from '../lib/detect.js';
import { defaultClaudeSettingsPath, mergeClaudeSettings } from '../lib/init/claude-settings-merge.js';
import { writeContextosJson } from '../lib/init/contextos-json.js';
import { type BaselineEnv, mergeEnvFile } from '../lib/init/env-merge.js';
import { seedFeaturePack } from '../lib/init/feature-pack-seed.js';
import { buildContextosMcpEntry, mergeMcpJson } from '../lib/init/mcp-merge.js';
import type { WriteOutcome } from '../lib/init/types.js';
import { openLocalDb } from '../lib/open-local-db.js';
import { bundledMigrationsDir, resolveRuntimeBinary } from '../lib/runtime-paths.js';
import { listAvailableTemplates, resolveTemplatePath } from '../lib/template-paths.js';
import { detectTemplate } from '../lib/templates/detect.js';
import { loadTemplate, type TemplateDefinition, TemplateLoadError } from '../lib/templates/load-template.js';

export interface InitOptions {
  readonly projectSlug?: string;
  readonly ide?: string;
  readonly graphify?: boolean;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly cwd?: string;
  /** Override `~/.contextos/` location. Tests pass a tmpdir; callers default to the user's resolved home. */
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
  readonly contextosHome: string;
  readonly projectSlug: string;
  readonly languages: string[];
  readonly ides: string[];
  readonly outcomes: WriteOutcome[];
  readonly dryRun: boolean;
}

export async function runInitCommand(options: InitOptions = {}, io: InitIO = DEFAULT_INIT_IO): Promise<never> {
  const env = options.env ?? process.env;
  const dryRun = options.dryRun === true;
  const force = options.force === true;

  const cwd = resolve(options.cwd ?? process.cwd());
  const detection = await detectProjectRoot(cwd);
  if (detection.markers.length === 0) {
    io.writeStderr(
      `${pc.red('contextos init')}: no project root marker found near ${cwd}. ` +
        'Run init from a directory that contains package.json, pyproject.toml, Cargo.toml, or .git.\n',
    );
    return io.exit(EXIT_USER_RECOVERABLE);
  }
  const root = detection.root;
  const projectSlug = sanitizeSlug(options.projectSlug ?? basename(root));
  if (projectSlug.length === 0) {
    io.writeStderr(`${pc.red('contextos init')}: could not derive a usable project slug from ${root}.\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  const userHome = options.userHome ?? homedir();
  const languages = await detectLanguages(root);
  const ides = await detectIDE({ homeDir: userHome });

  io.writeStdout(`${pc.green('✓')} Detected project root: ${root}\n`);
  if (languages.length > 0) {
    io.writeStdout(`${pc.green('✓')} Detected languages: ${languages.join(', ')}\n`);
  }
  if (ides.length > 0) {
    io.writeStdout(`${pc.green('✓')} Detected IDEs: ${ides.join(', ')}\n`);
  } else {
    io.writeStdout(`${pc.yellow('⚠')} No IDE config dir (~/.claude, ~/.cursor, ~/.windsurf) detected.\n`);
  }

  // Resolve and create ~/.contextos/{logs,pids} (data.db is created by openLocalDb).
  const contextosHome = resolveContextosHome({
    ...(options.home !== undefined ? { override: options.home } : {}),
    env,
  });
  if (!dryRun) {
    await mkdir(resolveContextosLogsDir(contextosHome), { recursive: true, mode: 0o700 });
    await mkdir(resolveContextosPidsDir(contextosHome), { recursive: true, mode: 0o700 });
  }
  io.writeStdout(`${pc.green('✓')} Resolved ContextOS home: ${contextosHome}\n`);

  // Apply migrations + seed F7 sentinel + register the user's project +
  // seed default policy rules (Phase 3 Fix D, 2026-05-02 — pre-Phase-3
  // init created the project but inserted zero rules; the evaluator
  // returned 'allow' for everything because no rule ever matched, so
  // every fresh install shipped with policy enforcement effectively
  // off).
  const dataDb = `${contextosHome}/data.db`;
  if (!dryRun) {
    const handle = await openLocalDb(dataDb, { loadVecExtension: true });
    try {
      migrateSqlite(handle.db);
      await ensureGlobalProject(handle);
      const projectResult = await ensureProject(handle, { slug: projectSlug });
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
    io.writeStderr(`${pc.red('contextos init')}: ${(err as Error).message}\n`);
    return io.exit(EXIT_ENVIRONMENT_PROBLEM);
  }
  const bundledMigrations = bundledMigrationsDir('sqlite');
  // Strip the dialect suffix so the env var conveys the parent dir
  // (`@coodra/contextos-db::MIGRATIONS_FOLDER` re-appends the dialect). Empty
  // when the resolver returned null (workspace dev mode) — the bundled
  // mcp-server falls through to its package-relative default.
  const migrationsDir =
    bundledMigrations !== null ? bundledMigrations.replace(/\/sqlite$/, '').replace(/\\sqlite$/, '') : null;

  const localHookSecret = randomBytes(32).toString('hex');
  const baselineEnv: BaselineEnv = {
    CONTEXTOS_MODE: 'solo',
    CLERK_SECRET_KEY: 'sk_test_replace_me',
    CLERK_PUBLISHABLE_KEY: 'pk_test_replace_me',
    LOCAL_HOOK_SECRET: localHookSecret,
    MCP_SERVER_PORT: '3100',
    HOOKS_BRIDGE_PORT: '3101',
  };

  const outcomes: WriteOutcome[] = [];

  // Write/merge .contextos.json
  outcomes.push(await writeContextosJson({ cwd: root, projectSlug, force, dryRun }));

  // Write/merge .mcp.json with the canonical contextos entry
  const mcpEntry = buildContextosMcpEntry({
    mcpServerBin,
    clerkSecretKey: baselineEnv.CLERK_SECRET_KEY,
    migrationsDir,
  });
  outcomes.push(await mergeMcpJson({ cwd: root, entry: mcpEntry, force, dryRun }));

  // Write/merge .env with solo-mode sentinels
  outcomes.push(await mergeEnvFile({ cwd: root, baseline: baselineEnv, force, dryRun }));

  // Write/merge ~/.claude/settings.json hook entries for SessionStart /
  // SessionEnd / PreToolUse / PostToolUse / Stop. This is the
  // load-bearing piece for the autonomy promise (decision
  // dec_83ba10c1, 2026-05-02): without it, Claude Code never POSTs to
  // the bridge and the bridge-coordination defaults (Pattern 20)
  // never fire.
  //
  // Phase 3 Fix B (2026-05-02): always run the merger, regardless of
  // whether `~/.claude/` exists at init time. v1 targets Claude Code
  // exclusively — installing ContextOS *is* the user's intent to wire
  // Claude Code, even before Claude Code itself has been launched. The
  // merger creates `~/.claude/` with mode 0700 if it's absent (see
  // `claude-settings-merge.ts`). Pre-Phase-3 the gate above silently
  // skipped the merge on machines without an existing `~/.claude/`,
  // shipping every fresh install of ContextOS without hooks wired.
  try {
    const claudeMerge = await mergeClaudeSettings({
      settingsPath: defaultClaudeSettingsPath(userHome),
      bridgePort: Number(baselineEnv.HOOKS_BRIDGE_PORT),
      force,
      dryRun,
    });
    outcomes.push(claudeMerge.outcome);
  } catch (err) {
    io.writeStderr(
      `${pc.yellow('⚠')} Could not merge ~/.claude/settings.json hook entries: ${(err as Error).message}\n`,
    );
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
        `${pc.yellow('⚠')} --template "${templateSelector}" not found (user templates: ~/.contextos/templates/, bundled: cli-dist/templates/). Falling back to skeleton.\n`,
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
  const seedOutcomes = await seedFeaturePack({
    cwd: root,
    slug: projectSlug,
    languages,
    force,
    dryRun,
    ...(template !== undefined ? { template } : {}),
    autoPopulate,
  });
  outcomes.push(...seedOutcomes);
  if (autoPopulate && template !== undefined) {
    io.writeStdout(
      `${pc.green('✓')} Auto-populated ${template.meta.autoSections.length} <!-- @auto:* --> section(s) from project shape.\n`,
    );
  }

  // Graphify is optional and out of 08a's required scope.
  if (options.graphify === false) {
    io.writeStdout(`${pc.yellow('⚠')} Skipping Graphify scan (--no-graphify)\n`);
  } else {
    io.writeStdout(
      `${pc.yellow('⚠')} Graphify scan not implemented in 08a — Feature Pack seeded with placeholder spec\n`,
    );
  }

  io.writeStdout('\n');
  for (const outcome of outcomes) {
    const glyph = actionGlyph(outcome.action);
    const note = outcome.notes !== undefined ? pc.gray(` (${outcome.notes})`) : '';
    io.writeStdout(`  ${glyph} ${outcome.path}${note}\n`);
  }

  io.writeStdout('\n');
  io.writeStdout(`${pc.green('ContextOS is ready')} (project '${projectSlug}').\n`);
  io.writeStdout('  → Restart your IDE so it picks up .mcp.json.\n');
  io.writeStdout('  → Run `contextos doctor` to verify the install.\n');
  io.writeStdout('  → Run `contextos start` to launch the MCP server + Hooks Bridge daemons.\n');

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
