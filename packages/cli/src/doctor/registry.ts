import { nodeVersionCheck } from './checks/01-node-version.js';
import { contextosDirCheck } from './checks/02-contextos-dir.js';
import { dataDbOpensCheck } from './checks/03-data-db-opens.js';
import { dbMigrationsHeadCheck } from './checks/04-db-migrations-head.js';
import { globalProjectCheck } from './checks/05-global-project.js';
import { policyKeyShapeCheck } from './checks/06-policy-key-shape.js';
import { runEventsRunIdCheck } from './checks/07-run-events-run-id.js';
import { bridgeRunIdLogsCheck } from './checks/08-bridge-runid-logs.js';
import { mcpStdioCheck } from './checks/09-mcp-stdio.js';
import { mcpHealthzCheck } from './checks/10-mcp-healthz.js';
import { bridgeHealthzCheck } from './checks/11-bridge-healthz.js';
import { projectRegisteredCheck } from './checks/12-project-registered.js';
import { auditDurabilityCheck } from './checks/13-audit-durability.js';
import { mcpConfigValidityCheck } from './checks/14-mcp-config-validity.js';
import { ideDetectionCheck } from './checks/15-ide-detection.js';
import { daemonManagerCheck } from './checks/16-daemon-manager.js';
import { port3100Check } from './checks/17-port-3100.js';
import { port3101Check } from './checks/18-port-3101.js';
import { pnpmPathCheck } from './checks/19-pnpm-path.js';
import { localHookSecretCheck } from './checks/20-local-hook-secret.js';
import { pendingJobsDepthCheck } from './checks/21-pending-jobs-depth.js';
import { pendingJobsOldestCheck } from './checks/22-pending-jobs-oldest.js';
import { pendingJobsDeadLetterCheck } from './checks/23-pending-jobs-dead-letter.js';
import { cloudReachabilityCheck } from './checks/24-cloud-reachability.js';
import { syncQueueDepthCheck } from './checks/25-sync-queue-depth.js';
import { syncLagCheck } from './checks/26-sync-lag.js';
import { syncDeadLetterCheck } from './checks/27-sync-dead-letter.js';
import { claudeHookRegistrationCheck } from './checks/28-claude-hook-registration.js';
import { preToolUseLoopCheck } from './checks/29-pre-tool-use-loop.js';
import { staleRunsCheck } from './checks/30-stale-runs.js';
import type { Check } from './types.js';

/**
 * Decision dec_83ba10c1 (2026-05-02): essential checks for the Claude
 * Code + solo-mode happy path. The default `contextos doctor` surface
 * runs only these. `--full` runs the registry below.
 *
 * Why these nine:
 *   - 1  Node version           — install gate
 *   - 2  ~/.contextos/ writable — install location
 *   - 3  data.db opens          — local SQLite primary store
 *   - 4  migrations at head     — schema invariant
 *   - 5  __global__ sentinel    — F7 invariant for unregistered cwds
 *   - 11 hooks-bridge /healthz  — bridge is the autonomy in-path
 *   - 12 project registered     — the cwd has a working .contextos.json
 *   - 14 .mcp.json validity     — Claude Code can spawn the MCP server
 *   - 20 LOCAL_HOOK_SECRET set  — bridge auth contract
 *
 * Everything else: debug invariants (6/7/8), redundant probes (10/17/18),
 * dev-only tooling (19), team-mode-only (24/25/26/27), outbox
 * observability (21/22/23), launch-mode dependent (9/15/16),
 * placeholder (13). All available via `contextos doctor --full`.
 */
// Slice 5 (2026-05-03 audit §14.1) adds 28+29 to the essential set —
// these catch the §3.2 / §9.2 bug class (matcher gate, SessionEnd
// registration) that doctor missed for weeks because it only checked
// process health. Check 30 (stale-runs warning) stays off-essential —
// it's an observability signal, not an install-gate invariant.
const ESSENTIAL_IDS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 11, 12, 14, 20, 28, 29]);

function tagEssential(checks: readonly Check[]): readonly Check[] {
  return checks.map((c) => ({ ...c, essential: ESSENTIAL_IDS.has(c.id) }));
}

export const ALL_CHECKS: readonly Check[] = tagEssential([
  nodeVersionCheck,
  contextosDirCheck,
  dataDbOpensCheck,
  dbMigrationsHeadCheck,
  globalProjectCheck,
  policyKeyShapeCheck,
  runEventsRunIdCheck,
  bridgeRunIdLogsCheck,
  mcpStdioCheck,
  mcpHealthzCheck,
  bridgeHealthzCheck,
  projectRegisteredCheck,
  auditDurabilityCheck,
  mcpConfigValidityCheck,
  ideDetectionCheck,
  daemonManagerCheck,
  port3100Check,
  port3101Check,
  pnpmPathCheck,
  localHookSecretCheck,
  pendingJobsDepthCheck,
  pendingJobsOldestCheck,
  pendingJobsDeadLetterCheck,
  cloudReachabilityCheck,
  syncQueueDepthCheck,
  syncLagCheck,
  syncDeadLetterCheck,
  // Slice 5 (2026-05-03 audit §14.1) — lifecycle invariants.
  claudeHookRegistrationCheck,
  preToolUseLoopCheck,
  staleRunsCheck,
]);

/**
 * The default subset run by `contextos doctor` (no `--full`).
 * Resolved at module load so callers don't pay the filter cost on
 * every invocation.
 */
export const ESSENTIAL_CHECKS: readonly Check[] = ALL_CHECKS.filter((c) => c.essential === true);
