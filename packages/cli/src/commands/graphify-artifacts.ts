import { execFile } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import { homedir, platform as osPlatform } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { EXIT_ENVIRONMENT_PROBLEM, EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { detectProjectRoot } from '../lib/detect.js';
import {
  absOf,
  type GraphifyPaths,
  LEGACY_OUT_REL,
  resolveGraphifyPaths,
  scanGraphifyArtifacts,
  writeGraphifyRecord,
} from '../lib/graphify/artifacts.js';
import { resolveGraphifyPython } from '../lib/init/graphify-python.js';
import { readProjectConfig } from '../lib/project-store/config.js';
import { classifyGeneratedPath, pruneManifestEntries, recordManifestEntries } from '../lib/project-store/index.js';
import { commandTitle, hintLine, pc, terminalWidth } from '../ui/index.js';

const execFileAsync = promisify(execFile);

/**
 * `coodra graphify build | open | clean` — the artifact half of the Graphify
 * integration (the wiring half is `enable`/`disable`/`status` in graphify.ts).
 *
 * `build` is a THIN wrapper: it resolves the user's installed `graphify`
 * executable, sets `GRAPHIFY_OUT` to the project's resolved output directory,
 * and invokes it. Coodra reimplements nothing (ADR-010/015: consume Graphify by
 * configuration, not code) — this exists so the managed output path is applied
 * consistently. The RICHER build path remains the assistant skill (`/graphify .`
 * inside your agent), which does semantic extraction using the host LLM; this
 * headless wrapper is the CI / no-assistant convenience, and `--code-only`
 * forwards Graphify's own structural-only mode.
 */

export interface GraphifyArtifactOptions {
  readonly json?: boolean;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  /**
   * `--no-llm` → Commander sets this to `false` (a `--no-X` flag negates `X`;
   * it does NOT produce a `noX` field — that mismatch silently disabled the
   * flag until live validation caught it). `false` = structural-only build:
   * runs Graphify's `update <path>` ("re-extract code files … no LLM needed")
   * instead of the default `graphify .`, which aborts without a backend key.
   * Verified against graphify 0.8.27 — there is NO `--code-only` flag.
   */
  readonly llm?: boolean;
  /** Forward `--backend <name>` (gemini|kimi|claude|openai|deepseek|ollama). `ollama` is local + key-free. */
  readonly backend?: string;
  /**
   * `--no-viz` → Commander sets this to `false` (same negation semantics as
   * `--no-llm`). Skips the aggregated-community `graph.html` fallback that
   * kicks in when the graph is too large for Graphify's own viz path. Useful
   * in CI, where nobody opens the HTML and rendering it is wasted work.
   */
  readonly viz?: boolean;
  /** Explicit path to the `graphify` executable. */
  readonly bin?: string;
  readonly cwd?: string;
  readonly userHome?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Injectable runner (tests) — defaults to spawning the real executable. */
  readonly runner?: (
    bin: string,
    args: readonly string[],
    opts: { cwd: string; env: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>;
  /** Injectable opener (tests). */
  readonly opener?: (path: string) => Promise<void>;
}

export interface GraphifyArtifactIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_GRAPHIFY_ARTIFACT_IO: GraphifyArtifactIO = {
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

async function resolveRoot(options: GraphifyArtifactOptions): Promise<string> {
  const userHome = options.userHome ?? homedir();
  return options.cwd ?? (await detectProjectRoot(process.cwd(), { homeDir: userHome })).root;
}

async function projectSlugFor(root: string): Promise<string> {
  const cfg = await readProjectConfig(root);
  return cfg?.projectSlug ?? 'unknown';
}

/**
 * Find the `graphify` executable. Preference order: explicit `--bin`, the
 * sibling of the resolved Python interpreter (a venv's `bin/graphify` when
 * `graphifyy[mcp]` was installed there), then bare `graphify` on PATH.
 */
async function resolveGraphifyBin(options: GraphifyArtifactOptions, cwd: string): Promise<string> {
  if (options.bin !== undefined && options.bin.length > 0) return options.bin;
  try {
    const resolution = await resolveGraphifyPython({ cwd, env: options.env ?? process.env });
    const python = resolution.python;
    if (isAbsolute(python)) {
      const candidate = join(dirname(python), 'graphify');
      return candidate;
    }
  } catch {
    // fall through to PATH
  }
  return 'graphify';
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

export async function runGraphifyBuildCommand(
  options: GraphifyArtifactOptions = {},
  io: GraphifyArtifactIO = DEFAULT_GRAPHIFY_ARTIFACT_IO,
): Promise<never> {
  const json = options.json === true;
  const dryRun = options.dryRun === true;
  const root = await resolveRoot(options);
  const paths = await resolveGraphifyPaths(root);
  const outAbs = absOf(root, paths.outputDir);
  const bin = await resolveGraphifyBin(options, root);
  // Verified against graphify 0.8.27:
  //   `graphify .`            → full build; ABORTS without an LLM backend key.
  //   `graphify update .`     → "re-extract code files … (no LLM needed)" — the
  //                             genuine key-free structural path.
  //   `--backend ollama`      → local model, also key-free, on the full build.
  const args =
    options.llm === false
      ? ['update', '.']
      : ['.', ...(options.backend !== undefined && options.backend.length > 0 ? ['--backend', options.backend] : [])];
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), GRAPHIFY_OUT: outAbs };

  if (dryRun) {
    const payload = { ok: true, command: 'build', dryRun: true, bin, args, graphifyOut: outAbs };
    if (json) io.writeStdout(`${JSON.stringify(payload, null, 2)}\n`);
    else {
      io.writeStdout(`${commandTitle('Graphify', 'build (dry-run)', { width: terminalWidth(), indent: 0 })}\n`);
      io.writeStdout(`  ${pc.gray(`would run: GRAPHIFY_OUT=${outAbs} ${bin} ${args.join(' ')}`)}\n`);
    }
    return io.exit(EXIT_OK);
  }

  const runner =
    options.runner ??
    (async (b, a, o) => {
      const { stdout, stderr } = await execFileAsync(b, [...a], {
        cwd: o.cwd,
        env: o.env,
        maxBuffer: 32 * 1024 * 1024,
      });
      return { stdout, stderr };
    });

  // Human header only — in --json mode stdout must carry JSON and nothing else.
  if (!json) {
    io.writeStdout(`${commandTitle('Graphify', 'build', { width: terminalWidth(), indent: 0 })}\n`);
    io.writeStdout(`  ${pc.gray(`output: ${paths.outputDir}${paths.managedByCoodra ? ' (Coodra-managed)' : ''}`)}\n`);
  }
  try {
    await runner(bin, args, { cwd: root, env });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const notFound = /ENOENT|not found|command not found/i.test(message);
    const needsKey = /no LLM API key|API key found/i.test(message);
    const detail = notFound
      ? `could not run '${bin}'. Install Graphify (\`uv tool install graphifyy\` or \`pip install "graphifyy[mcp]"\`), or pass --bin <path>. The richer path is the assistant skill: run \`/graphify .\` inside your agent.`
      : needsKey
        ? `graphify needs an LLM backend for a full build. Key-free options: \`coodra graphify build --no-llm\` (structural re-extract) or \`--backend ollama\` (local model). The richest path is \`/graphify .\` inside your agent, which uses its own model session. Original error: ${message}`
        : `graphify build failed: ${message}`;
    if (json) io.writeStdout(`${JSON.stringify({ ok: false, command: 'build', error: detail }, null, 2)}\n`);
    else io.writeStderr(`${pc.red('coodra graphify build')}: ${detail}\n`);
    return io.exit(notFound ? EXIT_ENVIRONMENT_PROBLEM : EXIT_USER_RECOVERABLE);
  }

  // Large-graph viz fallback. Verified against graphify 0.8.27: `to_html`
  // refuses any graph above `MAX_NODES_FOR_VIZ` (5000, overridable via
  // `GRAPHIFY_VIZ_NODE_LIMIT`) and the `update` path swallows that as
  // "Skipped graph.html". Every serious codebase clears 5000 nodes — this repo
  // produces 13,941 — so without a second pass the flagship artifact silently
  // never exists on exactly the repos people care about.
  //
  // Graphify's OWN answer is `graphify export html --node-limit N`, which
  // aggregates into a community-level meta-graph (761 community nodes here)
  // instead of raising. So we invoke that documented subcommand rather than
  // rendering anything ourselves — still "consume by configuration" (ADR-015).
  let vizNote: string | null = null;
  const preScan = await scanGraphifyArtifacts(root, paths);
  if (!preScan.graphHtml.exists && preScan.graphJson.exists && options.viz !== false) {
    const limit = vizNodeLimit(options.env ?? process.env);
    if ((preScan.counts?.nodes ?? 0) > limit) {
      try {
        await runner(bin, ['export', 'html', '--node-limit', String(limit)], { cwd: root, env });
        vizNote = `graph.html was skipped by the main build (${preScan.counts?.nodes} nodes > ${limit} viz limit); rendered the aggregated community view instead.`;
      } catch (err) {
        vizNote = `graph.html could not be rendered (${preScan.counts?.nodes} nodes > ${limit} viz limit). Raise GRAPHIFY_VIZ_NODE_LIMIT or run \`graphify export html --node-limit ${limit}\` manually. ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  // Record the produced artifacts into the manifest so `coodra files
  // status/clean` sees them. Managed output lives under the (gitignored)
  // `.coodra/` folder → `safe` to auto-clean; legacy `graphify-out/` is meant
  // to be committed, so it is classified `ask` instead.
  const scan = await scanGraphifyArtifacts(root, paths);
  // Persist the layout so it stays sticky: without a record, a stray
  // `graphify-out/` appearing later would flip resolution away from the
  // artifacts we just built.
  try {
    await writeGraphifyRecord(root, paths, { dryRun: false });
  } catch {
    // best-effort — the build itself succeeded
  }
  await recordArtifactsInManifest(root, paths, scan.graphJson.exists, 'coodra graphify build');

  if (json) {
    io.writeStdout(
      `${JSON.stringify({ ok: true, command: 'build', graphifyOut: outAbs, scan, ...(vizNote !== null ? { vizNote } : {}) }, null, 2)}\n`,
    );
    return io.exit(EXIT_OK);
  }
  renderScan(io, scan);
  if (vizNote !== null) io.writeStdout(`  ${pc.gray(vizNote)}\n`);
  io.writeStdout(`\n${hintLine('`coodra graphify status` for details · `coodra graphify open` to view the graph.')}\n`);
  return io.exit(EXIT_OK);
}

/**
 * Graphify's HTML viz node ceiling. Mirrors `graphify/export.py`:
 * `MAX_NODES_FOR_VIZ = 5000`, overridable by `GRAPHIFY_VIZ_NODE_LIMIT`
 * (non-integer / empty values fall back to the default).
 */
export function vizNodeLimit(env: NodeJS.ProcessEnv): number {
  const raw = env.GRAPHIFY_VIZ_NODE_LIMIT;
  if (typeof raw !== 'string' || raw.trim().length === 0) return 5000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
}

/** Classify + record the three Graphify artifacts into `.coodra/manifest.json`. */
export async function recordArtifactsInManifest(
  root: string,
  paths: GraphifyPaths,
  onlyIfPresent: boolean,
  createdBy: string,
): Promise<void> {
  if (!onlyIfPresent) return;
  const projectSlug = await projectSlugFor(root);
  const artifactPaths = [paths.graphJson, paths.graphHtml, paths.report];
  const entries = artifactPaths.map((p) => {
    const base = classifyGeneratedPath(absOf(root, p), root, createdBy);
    return {
      ...base,
      owner: 'graphify',
      kind: 'generated-artifact',
      // Managed output is gitignored + regenerable → safe. Legacy `graphify-out/`
      // is intended to be committed, so never auto-delete it.
      cleanup: paths.managedByCoodra ? ('safe' as const) : ('ask' as const),
      safeToDelete: true,
    };
  });
  // Graphify writes its incremental-extraction state to its DEFAULT
  // `graphify-out/manifest.json` regardless of GRAPHIFY_OUT (verified against
  // 0.8.27) — so a managed-layout build still leaves this file at the repo
  // root. Record it so `coodra files status` explains it instead of leaving an
  // unexplained stray. It is a cache: deleting it costs one full re-extraction
  // on the next build, nothing else — `safe` under the managed layout. Under
  // the legacy layout it lives inside the committed `graphify-out/` dir → the
  // same `ask` tier as the artifacts around it.
  const stateRel = `${LEGACY_OUT_REL}/manifest.json`;
  const stateAbs = absOf(root, stateRel);
  let stateExists = false;
  try {
    await stat(stateAbs);
    stateExists = true;
  } catch {
    // absent — nothing to record
  }
  if (stateExists) {
    entries.push({
      ...classifyGeneratedPath(stateAbs, root, createdBy),
      owner: 'graphify',
      kind: 'state-cache',
      cleanup: paths.managedByCoodra ? ('safe' as const) : ('ask' as const),
      safeToDelete: true,
    });
  }
  try {
    await recordManifestEntries({ root, projectSlug, entries, dryRun: false });
  } catch {
    // manifest is best-effort — the build already succeeded
  }
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

async function defaultOpener(path: string): Promise<void> {
  const p = osPlatform();
  const bin = p === 'darwin' ? 'open' : p === 'win32' ? 'cmd' : 'xdg-open';
  const args = p === 'win32' ? ['/c', 'start', '', path] : [path];
  await execFileAsync(bin, args);
}

export async function runGraphifyOpenCommand(
  options: GraphifyArtifactOptions = {},
  io: GraphifyArtifactIO = DEFAULT_GRAPHIFY_ARTIFACT_IO,
): Promise<never> {
  const json = options.json === true;
  const root = await resolveRoot(options);
  const paths = await resolveGraphifyPaths(root);
  const htmlAbs = absOf(root, paths.graphHtml);
  const scan = await scanGraphifyArtifacts(root, paths);

  if (!scan.graphHtml.exists) {
    const error = `no graph.html at ${paths.graphHtml}. Build the graph first: \`coodra graphify build\` (or \`/graphify .\` inside your agent).`;
    if (json) io.writeStdout(`${JSON.stringify({ ok: false, command: 'open', error }, null, 2)}\n`);
    else io.writeStderr(`${pc.red('coodra graphify open')}: ${error}\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  if (options.dryRun === true) {
    if (json)
      io.writeStdout(`${JSON.stringify({ ok: true, command: 'open', dryRun: true, path: htmlAbs }, null, 2)}\n`);
    else io.writeStdout(`  ${pc.gray(`would open ${htmlAbs}`)}\n`);
    return io.exit(EXIT_OK);
  }

  try {
    await (options.opener ?? defaultOpener)(htmlAbs);
  } catch (err) {
    const error = `could not open ${htmlAbs}: ${err instanceof Error ? err.message : String(err)}`;
    if (json) io.writeStdout(`${JSON.stringify({ ok: false, command: 'open', error }, null, 2)}\n`);
    else io.writeStderr(`${pc.red('coodra graphify open')}: ${error}\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  if (json) io.writeStdout(`${JSON.stringify({ ok: true, command: 'open', path: htmlAbs }, null, 2)}\n`);
  else io.writeStdout(`${pc.green('✓')} Opened ${htmlAbs}\n`);
  return io.exit(EXIT_OK);
}

// ---------------------------------------------------------------------------
// clean
// ---------------------------------------------------------------------------

export async function runGraphifyCleanCommand(
  options: GraphifyArtifactOptions = {},
  io: GraphifyArtifactIO = DEFAULT_GRAPHIFY_ARTIFACT_IO,
): Promise<never> {
  const json = options.json === true;
  const dryRun = options.dryRun === true;
  const root = await resolveRoot(options);
  const paths = await resolveGraphifyPaths(root);
  const outAbs = absOf(root, paths.outputDir);

  // Safety: never delete outside the project root, even if a record pins an
  // absolute path elsewhere.
  const rel = relative(root, outAbs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    const error = `refusing to clean '${outAbs}' — it is outside the project root (${root}).`;
    if (json) io.writeStdout(`${JSON.stringify({ ok: false, command: 'clean', error }, null, 2)}\n`);
    else io.writeStderr(`${pc.red('coodra graphify clean')}: ${error}\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  const scan = await scanGraphifyArtifacts(root, paths);
  const targets = [
    { label: paths.graphJson, abs: absOf(root, paths.graphJson), present: scan.graphJson.exists },
    { label: paths.graphHtml, abs: absOf(root, paths.graphHtml), present: scan.graphHtml.exists },
    { label: paths.report, abs: absOf(root, paths.report), present: scan.report.exists },
  ].filter((t) => t.present);

  // Legacy `graphify-out/` is meant to be committed to git — require --force.
  if (!paths.managedByCoodra && !options.force && targets.length > 0) {
    const error = `'${paths.outputDir}' is Graphify's own (git-committed) output directory. Re-run with --force to delete it, or migrate to Coodra-managed output with \`coodra graphify enable\`.`;
    if (json) io.writeStdout(`${JSON.stringify({ ok: false, command: 'clean', error, deleted: [] }, null, 2)}\n`);
    else io.writeStderr(`${pc.yellow('⚠')} ${error}\n`);
    return io.exit(EXIT_USER_RECOVERABLE);
  }

  const deleted: string[] = [];
  if (!dryRun) {
    for (const t of targets) {
      try {
        await rm(t.abs, { force: true, recursive: true });
        deleted.push(t.label);
      } catch {
        // best-effort per file
      }
    }
    // Drop the cache dir + the (now-empty) output dir for managed layouts.
    if (paths.managedByCoodra) {
      await rm(join(outAbs, 'cache'), { force: true, recursive: true }).catch(() => {});
      await rm(outAbs, { force: true, recursive: true }).catch(() => {});
    }
    if (deleted.length > 0) await pruneManifestEntries(root, deleted, { dryRun: false });
  }

  const reported = dryRun ? targets.map((t) => t.label) : deleted;
  if (json) {
    io.writeStdout(`${JSON.stringify({ ok: true, command: 'clean', dryRun, deleted: reported }, null, 2)}\n`);
    return io.exit(EXIT_OK);
  }
  io.writeStdout(
    `${commandTitle('Graphify', `clean${dryRun ? ' (dry-run)' : ''}`, { width: terminalWidth(), indent: 0 })}\n`,
  );
  if (reported.length === 0) {
    io.writeStdout(`  ${pc.gray('No Graphify artifacts to remove.')}\n`);
  } else {
    for (const p of reported) io.writeStdout(`  ${pc.green('•')} ${dryRun ? 'would remove' : 'removed'} ${p}\n`);
  }
  io.writeStdout(
    `\n${hintLine('Rebuild any time with `coodra graphify build` or `/graphify .` inside your agent.')}\n`,
  );
  return io.exit(EXIT_OK);
}

// ---------------------------------------------------------------------------
// shared render
// ---------------------------------------------------------------------------

export function renderScan(io: GraphifyArtifactIO, scan: Awaited<ReturnType<typeof scanGraphifyArtifacts>>): void {
  const g = scan.graphJson;
  if (!g.exists) {
    io.writeStdout(`  ${pc.gray('✗')} ${scan.paths.graphJson} ${pc.gray('(not built yet)')}\n`);
    return;
  }
  const kb = Math.max(1, Math.round((g.sizeBytes ?? 0) / 1024));
  io.writeStdout(`  ${pc.green('✓')} ${scan.paths.graphJson} ${pc.gray(`(${kb} KB · ${g.modifiedAt ?? '?'})`)}\n`);
  if (scan.counts !== null) {
    io.writeStdout(
      `    ${pc.gray(`${scan.counts.nodes} nodes · ${scan.counts.links} links · ${scan.counts.communities} communities`)}\n`,
    );
  } else if (scan.countsSkippedReason !== undefined) {
    io.writeStdout(`    ${pc.yellow('◌')} ${pc.gray(scan.countsSkippedReason)}\n`);
  }
  const html = scan.graphHtml.exists ? pc.green('✓') : pc.gray('✗');
  const rep = scan.report.exists ? pc.green('✓') : pc.gray('✗');
  io.writeStdout(`  ${html} ${scan.paths.graphHtml}\n`);
  io.writeStdout(`  ${rep} ${scan.paths.report}\n`);
}
