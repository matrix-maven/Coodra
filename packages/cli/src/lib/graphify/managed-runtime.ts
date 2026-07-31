import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  detectUv,
  type InstallCommandRunner,
  planGraphifyInstall,
  runGraphifyInstall,
} from '../init/graphify-install.js';
import { type VerifyResult, venvPythonPath, verifyGraphifyPython } from '../init/graphify-python.js';

export const MANAGED_GRAPHIFY_RUNTIME_REL = 'graphify-mcp' as const;

export function managedGraphifyRuntimeRoot(coodraHome: string): string {
  return join(coodraHome, MANAGED_GRAPHIFY_RUNTIME_REL);
}

export function managedGraphifyPythonPath(coodraHome: string, platform: NodeJS.Platform = process.platform): string {
  return venvPythonPath(join(managedGraphifyRuntimeRoot(coodraHome), '.venv'), platform);
}

export type ManagedGraphifyRuntimeResult =
  | {
      readonly ok: true;
      readonly python: string;
      readonly runtimeRoot: string;
      readonly installed: boolean;
      readonly tool: 'uv' | 'pip' | 'existing';
    }
  | {
      readonly ok: false;
      readonly python: string;
      readonly runtimeRoot: string;
      readonly error: string;
    };

export interface EnsureManagedGraphifyRuntimeOptions {
  readonly coodraHome: string;
  readonly dryRun: boolean;
  readonly runner?: InstallCommandRunner;
  readonly probeUv?: () => Promise<boolean>;
  readonly verify?: (pythonPath: string) => Promise<VerifyResult>;
  readonly writeStdout?: (chunk: string) => void;
  readonly platform?: NodeJS.Platform;
}

/**
 * Ensure the machine-level Graphify MCP runtime exists under Coodra home.
 *
 * The agent plugin MCP entries are global, but each spawned Graphify server
 * reads a project-local graph path. Keeping the package install under
 * `~/.coodra/graphify-mcp/.venv` gives every project the same server runtime
 * without creating a `.venv` in every repo. `uv` is preferred when available;
 * the fallback is Python's stdlib venv + pip, so Coodra can still install the
 * dependency on machines without uv.
 */
export async function ensureManagedGraphifyRuntime(
  opts: EnsureManagedGraphifyRuntimeOptions,
): Promise<ManagedGraphifyRuntimeResult> {
  const runtimeRoot = managedGraphifyRuntimeRoot(opts.coodraHome);
  const python = managedGraphifyPythonPath(opts.coodraHome, opts.platform);
  const verify = opts.verify ?? ((p: string) => verifyGraphifyPython(p));

  const existing = await verify(python);
  if (existing.ok) return { ok: true, python, runtimeRoot, installed: false, tool: 'existing' };
  if (opts.dryRun) return { ok: true, python, runtimeRoot, installed: false, tool: 'existing' };

  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const hasUv = await (opts.probeUv?.() ?? detectUv(opts.runner, runtimeRoot));
  const plan = planGraphifyInstall({
    cwd: runtimeRoot,
    hasUv,
    ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
  });
  const result = await runGraphifyInstall(plan, {
    cwd: runtimeRoot,
    ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
    onStep: (label) => opts.writeStdout?.(`  ${label}\n`),
  });
  if (!result.ok) {
    return {
      ok: false,
      python,
      runtimeRoot,
      error: `install failed at "${result.failedStep}": ${result.detail}`,
    };
  }

  const postInstall = await verify(result.venvPython);
  if (!postInstall.ok) {
    return {
      ok: false,
      python: result.venvPython,
      runtimeRoot,
      error: `installed, but Graphify MCP import probe still fails: ${postInstall.detail}`,
    };
  }

  return { ok: true, python: result.venvPython, runtimeRoot, installed: true, tool: plan.tool };
}
