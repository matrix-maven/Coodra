import { nodeVersionCheck } from './checks/01-node-version.js';
import { coodraDirCheck } from './checks/02-coodra-dir.js';
import { dataDbOpensCheck } from './checks/03-data-db-opens.js';
import { dbMigrationsHeadCheck } from './checks/04-db-migrations-head.js';
import { globalProjectCheck } from './checks/05-global-project.js';
import { policyKeyShapeCheck } from './checks/06-policy-key-shape.js';
import { runEventsRunIdCheck } from './checks/07-run-events-run-id.js';
import { mcpStdioCheck } from './checks/09-mcp-stdio.js';
import { mcpHealthzCheck } from './checks/10-mcp-healthz.js';
import { projectRegisteredCheck } from './checks/12-project-registered.js';
import { auditDurabilityCheck } from './checks/13-audit-durability.js';
import { mcpConfigValidityCheck } from './checks/14-mcp-config-validity.js';
import { ideDetectionCheck } from './checks/15-ide-detection.js';
import { daemonManagerCheck } from './checks/16-daemon-manager.js';
import { port3100Check } from './checks/17-port-3100.js';
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
import { activeKillSwitchesCheck } from './checks/31-active-kill-switches.js';
import { upgradeAvailableCheck } from './checks/32-upgrade-available.js';
import { staleBackupsCheck } from './checks/33-stale-backups.js';
import { bundledTemplatesCheck } from './checks/34-bundled-templates.js';
import { autoMarkerSmokeCheck } from './checks/35-auto-marker-smoke.js';
import { teamConfigCheck } from './checks/36-team-config.js';
import { webHealthzCheck } from './checks/37-web-healthz.js';
import { tunnelReachabilityCheck } from './checks/38-tunnel-reachability.js';
import { codexHookRegistrationCheck } from './checks/39-codex-hook-registration.js';
import type { Check } from './types.js';

/**
 * Decision dec_83ba10c1 (2026-05-02): essential checks for the Claude
 * Code + solo-mode happy path. The default `coodra doctor` surface
 * runs only these. `--full` runs the registry below.
 *
 * Why these:
 *   - 1  Node version           — install gate
 *   - 2  ~/.coodra/ writable — install location
 *   - 3  data.db opens          — local SQLite primary store
 *   - 4  migrations at head     — schema invariant
 *   - 5  __global__ sentinel    — F7 invariant for unregistered cwds
 *   - 10 mcp-server /healthz    — MCP is the sole lifecycle transport
 *                                 post-COOD-53 (hooks-bridge retired)
 *   - 12 project registered     — the cwd has a working .coodra/config.json
 *   - 14 MCP wiring             — native plugin MCP present
 *   - 20 LOCAL_HOOK_SECRET set  — MCP HTTP transport auth contract
 *
 * Everything else: debug invariants (6/7), redundant probes (17),
 * dev-only tooling (19), team-mode-only (24/25/26/27), outbox
 * observability (21/22/23), launch-mode dependent (9/15/16),
 * placeholder (13). All available via `coodra doctor --full`.
 *
 * COOD-53 (2026-08-08): dropped 11 (hooks-bridge /healthz) and 18
 * (hooks-bridge port 3101) — that daemon and transport are retired.
 * Check 10 (mcp-server /healthz) is promoted into the essential set in
 * 11's place, since MCP is now the only lifecycle transport for every
 * agent.
 */
// Slice 5 (2026-05-03 audit §14.1) adds 28+29 to the essential set —
// these catch the §3.2 / §9.2 bug class (matcher gate, SessionEnd
// registration) that doctor missed for weeks because it only checked
// process health. Check 30 (stale-runs warning) stays off-essential —
// it's an observability signal, not an install-gate invariant.
// Check 39 joins the essential set alongside 28 (2026-08-08): Codex is
// now an equally first-class native-plugin agent, and 28's own precedent
// already accepts an always-yellow result for users on a different agent
// as the cost of catching this bug class on the happy path.
const ESSENTIAL_IDS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 10, 12, 14, 20, 28, 29, 39]);

function tagEssential(checks: readonly Check[]): readonly Check[] {
  return checks.map((c) => ({ ...c, essential: ESSENTIAL_IDS.has(c.id) }));
}

export const ALL_CHECKS: readonly Check[] = tagEssential([
  nodeVersionCheck,
  coodraDirCheck,
  dataDbOpensCheck,
  dbMigrationsHeadCheck,
  globalProjectCheck,
  policyKeyShapeCheck,
  runEventsRunIdCheck,
  mcpStdioCheck,
  mcpHealthzCheck,
  projectRegisteredCheck,
  auditDurabilityCheck,
  mcpConfigValidityCheck,
  ideDetectionCheck,
  daemonManagerCheck,
  port3100Check,
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
  codexHookRegistrationCheck,
  preToolUseLoopCheck,
  staleRunsCheck,
  // M08b S18 — operational visibility checks (operator-facing,
  // never essential — `--full` only).
  activeKillSwitchesCheck,
  upgradeAvailableCheck,
  staleBackupsCheck,
  bundledTemplatesCheck,
  autoMarkerSmokeCheck,
  // Module 04 Phase 4 — team-mode bootstrap state.
  teamConfigCheck,
  // Web Bundle W1 (2026-05-13) — bundled Next.js standalone /api/healthz.
  webHealthzCheck,
  // Web Bundle W4 (2026-05-13) — Cloudflare tunnel reachability when
  // COODRA_PUBLIC_URL is set.
  tunnelReachabilityCheck,
]);

/**
 * The default subset run by `coodra doctor` (no `--full`).
 * Resolved at module load so callers don't pay the filter cost on
 * every invocation.
 */
export const ESSENTIAL_CHECKS: readonly Check[] = ALL_CHECKS.filter((c) => c.essential === true);
