import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pc } from '../../ui/compat.js';
import {
  type GraphifyPythonResolution,
  type VerifyResult,
  venvPythonPath,
  verifyGraphifyPython,
} from './graphify-python.js';

const pexec = promisify(execFile);

/**
 * `graphify-install.ts` — plan + execute the `graphifyy[mcp]` install so
 * `coodra graphify enable` (and `coodra init --graphify`) can offer to
 * install the package instead of wiring a dead entry and printing manual
 * steps.
 *
 * Field report (2026-07-02): a user answered "Wire Graphify? y", got the
 * "no working interpreter found yet" notice, and the wired server (and
 * the `/graphify` assistant command) simply didn't work — the install
 * instructions were printed but never run. The right order is install
 * FIRST, then wire the entry against the interpreter that now verifies.
 *
 * Two consent-sensitive cases the caller must distinguish:
 *   - `<cwd>/.venv` already exists → it's the USER's venv; we ask before
 *     installing into it (never write into someone's environment
 *     silently).
 *   - no `.venv` → we ask before creating one + installing.
 *
 * Tool preference: `uv` when present (fast, and what the docs recommend),
 * otherwise stdlib `python3 -m venv` + `pip`. Every subprocess is
 * injectable so unit tests never spawn real processes.
 */

export interface InstallStep {
  readonly cmd: string;
  readonly args: readonly string[];
  /** Human-readable one-liner shown while the step runs. */
  readonly label: string;
}

export interface GraphifyInstallPlan {
  /** `<cwd>/.venv` — the venv the install targets. */
  readonly venvDir: string;
  /** True when the venv already existed (consent wording differs). */
  readonly venvExists: boolean;
  /** The interpreter the install produces / augments. */
  readonly venvPython: string;
  /** 'uv' when uv is on PATH, else the stdlib venv+pip fallback. */
  readonly tool: 'uv' | 'pip';
  readonly steps: readonly InstallStep[];
}

/** Runner abstraction over execFile — injectable for tests. */
export type InstallCommandRunner = (
  cmd: string,
  args: readonly string[],
  opts: { readonly cwd: string; readonly timeoutMs: number },
) => Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }>;

export const defaultInstallRunner: InstallCommandRunner = async (cmd, args, opts) => {
  try {
    await pexec(cmd, [...args], { cwd: opts.cwd, timeout: opts.timeoutMs });
    return { ok: true };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string | Buffer };
    if (e.code === 'ENOENT') return { ok: false, detail: `command not found: ${cmd}` };
    const stderrRaw = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? '');
    const lastLine =
      stderrRaw
        .trim()
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .pop() ?? e.message;
    return { ok: false, detail: lastLine.slice(0, 300) };
  }
};

/** Probe whether `uv` is runnable. Injectable for tests. */
export async function detectUv(runner: InstallCommandRunner = defaultInstallRunner, cwd = '.'): Promise<boolean> {
  const r = await runner('uv', ['--version'], { cwd, timeoutMs: 5_000 });
  return r.ok;
}

export interface PlanGraphifyInstallOptions {
  readonly cwd: string;
  readonly platform?: NodeJS.Platform;
  /** Pre-resolved uv availability (callers that already probed). */
  readonly hasUv: boolean;
}

/**
 * Build the step list. Creation of `.venv` is skipped when it already
 * exists — in that case the caller must have asked the user for consent
 * to install into THEIR venv (see `venvExists`).
 */
export function planGraphifyInstall(options: PlanGraphifyInstallOptions): GraphifyInstallPlan {
  const platform = options.platform ?? process.platform;
  const venvDir = join(options.cwd, '.venv');
  const venvExists = existsSync(venvDir);
  const venvPython = venvPythonPath(venvDir, platform);

  const steps: InstallStep[] = [];
  if (options.hasUv) {
    if (!venvExists) {
      steps.push({ cmd: 'uv', args: ['venv', '.venv'], label: 'create .venv (uv venv)' });
    }
    steps.push({
      cmd: 'uv',
      args: ['pip', 'install', '--python', venvPython, 'graphifyy[mcp]'],
      label: 'install graphifyy[mcp] (uv pip)',
    });
    return { venvDir, venvExists, venvPython, tool: 'uv', steps };
  }

  if (!venvExists) {
    steps.push({
      cmd: platform === 'win32' ? 'python' : 'python3',
      args: ['-m', 'venv', '.venv'],
      label: 'create .venv (python -m venv)',
    });
  }
  steps.push({
    cmd: venvPython,
    args: ['-m', 'pip', 'install', 'graphifyy[mcp]'],
    label: 'install graphifyy[mcp] (pip)',
  });
  return { venvDir, venvExists, venvPython, tool: 'pip', steps };
}

export type GraphifyInstallResult =
  | { readonly ok: true; readonly venvPython: string }
  | { readonly ok: false; readonly failedStep: string; readonly detail: string };

/**
 * Execute the plan sequentially, stopping at the first failure. Package
 * downloads can take a while — each step gets a 5-minute budget.
 */
export async function runGraphifyInstall(
  plan: GraphifyInstallPlan,
  opts: {
    readonly cwd: string;
    readonly runner?: InstallCommandRunner;
    /** Progress callback — one call per step, before it runs. */
    readonly onStep?: (label: string) => void;
  },
): Promise<GraphifyInstallResult> {
  const runner = opts.runner ?? defaultInstallRunner;
  for (const step of plan.steps) {
    opts.onStep?.(step.label);
    const r = await runner(step.cmd, step.args, { cwd: opts.cwd, timeoutMs: 300_000 });
    if (!r.ok) {
      return { ok: false, failedStep: step.label, detail: r.detail };
    }
  }
  return { ok: true, venvPython: plan.venvPython };
}

export interface OfferGraphifyInstallOptions {
  /** The (unverified) resolution the interpreter probe produced. */
  readonly resolution: GraphifyPythonResolution;
  readonly cwd: string;
  /** True when a human can answer a prompt (TTY or injected readPrompt). */
  readonly interactive: boolean;
  /**
   * `--install` / `--no-install`: `true` installs without asking,
   * `false` suppresses the offer entirely, `undefined` prompts when
   * interactive.
   */
  readonly installFlag?: boolean;
  readonly readPrompt?: (question: string) => Promise<string>;
  readonly writeStdout: (chunk: string) => void;
  /** Injectable subprocess runner (tests). */
  readonly runner?: InstallCommandRunner;
  /** Injectable post-install verifier (tests). */
  readonly verify?: (pythonPath: string) => Promise<VerifyResult>;
  /** Injectable uv probe (tests). */
  readonly probeUv?: () => Promise<boolean>;
  readonly platform?: NodeJS.Platform;
}

/**
 * The install-first flow: when the interpreter probe found nothing that
 * can serve Graphify, offer to install `graphifyy[mcp]` into the
 * project's `.venv` BEFORE the entry is wired — so the wired entry
 * points at an interpreter that actually works.
 *
 * Consent rules (field report 2026-07-02):
 *   - existing `.venv` → ask "install into it?" — it's the user's venv.
 *   - no `.venv` → ask "create .venv and install?".
 *   - non-interactive with no `--install` → no offer (unchanged
 *     behaviour: wire + print the manual steps).
 *
 * Returns the resolution to wire with: the verified `.venv` interpreter
 * on success, the original (unverified) resolution otherwise.
 */
export async function offerGraphifyInstall(opts: OfferGraphifyInstallOptions): Promise<GraphifyPythonResolution> {
  if (opts.resolution.verified) return opts.resolution;
  if (opts.installFlag === false) return opts.resolution;

  const hasUv = await (opts.probeUv?.() ?? detectUv(opts.runner ?? defaultInstallRunner, opts.cwd));
  const plan = planGraphifyInstall({
    cwd: opts.cwd,
    hasUv,
    ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
  });

  let consented = opts.installFlag === true;
  if (!consented) {
    if (!opts.interactive || opts.readPrompt === undefined) return opts.resolution;
    const question = plan.venvExists
      ? `  Found an existing ${pc.cyan('.venv')} in this project. Install ${pc.cyan('graphifyy[mcp]')} into it? [${pc.cyan('Y')}/n]: `
      : `  No interpreter with ${pc.cyan('graphifyy[mcp]')} found. Create ${pc.cyan('.venv')} and install it now? [${pc.cyan('Y')}/n]: `;
    const answer = (await opts.readPrompt(question)).trim().toLowerCase();
    consented = answer !== 'n' && answer !== 'no';
    if (!consented) {
      opts.writeStdout(`${pc.gray('·')} Skipping the install — the manual steps are printed below.\n`);
      return opts.resolution;
    }
  }

  const result = await runGraphifyInstall(plan, {
    cwd: opts.cwd,
    ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
    onStep: (label) => {
      opts.writeStdout(`  ${pc.gray('→')} ${pc.gray(label)}\n`);
    },
  });
  if (!result.ok) {
    opts.writeStdout(`  ${pc.red('✗')} Install failed at "${result.failedStep}": ${result.detail}\n`);
    return opts.resolution;
  }

  const verify = opts.verify ?? ((p: string) => verifyGraphifyPython(p));
  const verified = await verify(result.venvPython);
  if (!verified.ok) {
    opts.writeStdout(
      `  ${pc.yellow('◌')} Installed, but \`${result.venvPython} -c "import graphify.serve, mcp"\` still fails: ${verified.detail}\n`,
    );
    return { ...opts.resolution, python: result.venvPython, detail: verified.detail };
  }

  opts.writeStdout(`  ${pc.green('✓')} Installed graphifyy[mcp] into ${pc.cyan(plan.venvDir)}.\n`);
  return { python: result.venvPython, verified: true, source: 'venv' };
}
