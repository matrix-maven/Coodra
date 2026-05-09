import type { DbHandle } from '@coodra/contextos-db';
import { createLogger } from '@coodra/contextos-shared';
import type { HookEvent } from '@coodra/contextos-shared/hooks';

import type { HookDispatchResult } from '../app.js';
import { abandonStaleInProgressRuns } from '../lib/abandon-stale-runs.js';
import { loadFeaturePackForSession } from '../lib/feature-pack-loader.js';
import { loadFeaturesIndexForSession } from '../lib/features-index-loader.js';
import { loadRecentDecisionsForSession } from '../lib/recent-decisions.js';
import type { ProjectSlugResolver } from '../lib/resolve-project-slug.js';
import type { RunRecorder } from '../lib/run-recorder.js';

/**
 * Module 05 §6.C — Session Contract block. Injected into the agent's
 * turn-zero context to remind it that `save_context_pack` is the
 * canonical record and the bridge's auto-save is a fallback floor.
 *
 * Agents condition on early system content reliably; this is one of the
 * highest-leverage placements available for compliance. The block is
 * compact (~60 tokens) so the cost is negligible against the agent's
 * 200k context window.
 */
const M05_SESSION_CONTRACT = [
  '## Session contract',
  '',
  'This session ends with a call to `save_context_pack` — a narrative recap of what',
  "was built, what was decided, what is still open. Don't skip it. The bridge writes",
  'a structured digest as a safety net only; your call is the canonical record the',
  'next session reads. When you make a design or implementation choice mid-session,',
  'call `record_decision` immediately (not retrospectively) with `confidence`,',
  '`impact`, and `reversible` populated when known.',
].join('\n');

/**
 * `apps/hooks-bridge/src/handlers/session-start` — opens the `runs`
 * row AND injects the project-level Feature Pack into the agent's
 * turn-zero context via Claude Code's `additionalContext` field.
 *
 * Decision dec_83ba10c1 (2026-05-02 — Bridge-mediated autonomous
 * coordination defaults, system-architecture §16 Pattern 20). Pre-
 * decision the SessionStart handler returned only `permissionDecision:
 * 'allow'` and the agent had to remember to call `contextos__
 * get_feature_pack` itself. With this change, every Claude Code
 * SessionStart hook ships the pack body inline — no agent action
 * required.
 *
 * Failure modes (all return allow + log):
 *   - projectSlug not resolved (no `.contextos.json` in cwd) → no
 *     additionalContext, log `session_start_no_project_slug`.
 *   - Feature Pack files absent on disk → no additionalContext, log
 *     `session_start_pack_not_found`. Agents fall through to the
 *     §24 MCP tool path if they need it mid-session.
 *
 * Audit (run_events / runs row) is fire-and-forget per §16 pattern
 * 3 outbox. Pack injection is awaited because the response shape
 * carries it; latency is bounded by the three Promise.all reads
 * against `<cwd>/docs/feature-packs/<slug>/*.md` (~1ms typical).
 */

const sessionStartLogger = createLogger('hooks-bridge.session-start');

export interface CreateSessionStartHandlerDeps {
  readonly runRecorder: RunRecorder;
  readonly projectSlugResolver: ProjectSlugResolver;
  readonly db: DbHandle;
  readonly mode: 'solo' | 'team';
}

export type SessionStartHandler = (event: HookEvent) => Promise<HookDispatchResult>;

export function createSessionStartHandler(deps: CreateSessionStartHandlerDeps): SessionStartHandler {
  return async function handleSessionStart(event) {
    if (event.eventPhase !== 'session_start') {
      sessionStartLogger.warn(
        { event: 'event_phase_mismatch', sessionId: event.sessionId, phase: event.eventPhase },
        'session-start handler called for non-session_start event; allowing',
      );
      return { permissionDecision: 'allow', permissionDecisionReason: 'event_phase_mismatch' };
    }
    // M04 Phase 2 S1 (F3 root-cause fix): resolveAndEnsure auto-creates
    // the projects row when SessionStart fires from an un-registered
    // cwd. Subsequent PreToolUse / PostToolUse events from the same
    // cwd will then find the row already present (60s cache hit).
    const { slug, projectId } = await deps.projectSlugResolver.resolveAndEnsure(event.cwd, deps.db);
    deps.runRecorder.recordSessionStart({ event, projectId, mode: deps.mode });

    // Slice 8 (2026-05-03 audit §14.3): fire-and-forget orphan cleanup.
    // Mark prior in_progress runs for the same project as 'abandoned'
    // so query_run_history doesn't surface them as live work. Excludes
    // the just-arrived session_id so we never clobber the run the
    // outbox is about to insert. Errors are logged + swallowed in the
    // helper — the SessionStart response should not block on cleanup.
    if (typeof projectId === 'string' && projectId.length > 0) {
      void abandonStaleInProgressRuns({
        db: deps.db,
        projectId,
        excludeSessionId: event.sessionId,
      }).catch((err) => {
        sessionStartLogger.warn(
          {
            event: 'abandon_stale_runs_failed',
            sessionId: event.sessionId,
            projectId,
            err: err instanceof Error ? err.message : String(err),
          },
          'fire-and-forget orphan cleanup threw; SessionStart response unaffected',
        );
      });
    }

    // M05 §6.C + §7: assemble the additionalContext from three blocks,
    // separated by horizontal rules. Order matters — feature pack first
    // (the project body), session contract second (priming), recent
    // decisions last (situational awareness):
    //   1. Feature Pack content (existing — Pattern 20 from M04)
    //   2. Session Contract (M05 §6.C — compliance reminder, always)
    //   3. Recent decisions (M05 §7 — cross-developer awareness)
    // Each block independently fail-opens; the contract is static so
    // it always renders.
    let featurePackBlock: string | null = null;
    let featuresIndexBlock: string | null = null;
    let recentDecisionsBlock: string | null = null;
    const slugValue = typeof slug === 'string' && slug.length > 0 ? slug : null;
    const cwdValue = typeof event.cwd === 'string' && event.cwd.length > 0 ? event.cwd : null;
    if (slugValue !== null && cwdValue !== null) {
      const projectSlug: string = slugValue;
      const cwd: string = cwdValue;
      try {
        const loaded = await loadFeaturePackForSession({ cwd, projectSlug });
        if (loaded !== null) {
          featurePackBlock = loaded.content;
        }
      } catch (err) {
        sessionStartLogger.warn(
          {
            event: 'session_start_feature_pack_load_failed',
            sessionId: event.sessionId,
            projectSlug,
            err: err instanceof Error ? err.message : String(err),
          },
          'feature-pack load threw; SessionStart proceeding without feature-pack block',
        );
      }
      // 2026-05-08 — features index injection (Phase C of the skill-style
      // features rollout). Independently fail-opens; if `docs/features/`
      // doesn't exist or the index is unreadable, this returns null and
      // the additionalContext composition skips the block. The loader
      // also handles stale-regen, size capping, and oldest-first
      // truncation. See `lib/features-index-loader.ts` for the contract.
      try {
        const loaded = await loadFeaturesIndexForSession({ cwd, projectSlug });
        if (loaded !== null) {
          featuresIndexBlock = loaded.content;
          sessionStartLogger.info(
            {
              event: 'session_start_features_index_loaded',
              sessionId: event.sessionId,
              projectSlug,
              entriesShown: loaded.entriesShown,
              entriesTotal: loaded.entriesTotal,
              bytes: loaded.bytes,
            },
            'features index ready for SessionStart injection',
          );
        }
      } catch (err) {
        sessionStartLogger.warn(
          {
            event: 'session_start_features_index_load_failed',
            sessionId: event.sessionId,
            projectSlug,
            err: err instanceof Error ? err.message : String(err),
          },
          'features-index load threw; SessionStart proceeding without features block',
        );
      }
      if (typeof projectId === 'string' && projectId.length > 0) {
        try {
          const recentBlock = await loadRecentDecisionsForSession({
            db: deps.db,
            projectId,
            projectSlug,
          });
          if (recentBlock !== null && recentBlock.length > 0) {
            recentDecisionsBlock = recentBlock;
          }
        } catch (err) {
          sessionStartLogger.warn(
            {
              event: 'session_start_recent_decisions_failed',
              sessionId: event.sessionId,
              projectSlug,
              err: err instanceof Error ? err.message : String(err),
            },
            'recent-decisions load threw; SessionStart proceeding without recent-decisions block',
          );
        }
      }
    } else {
      sessionStartLogger.info(
        { event: 'session_start_no_project_slug', sessionId: event.sessionId, cwd: event.cwd },
        'no project slug for cwd; SessionStart proceeding with contract-only additionalContext',
      );
    }

    // Block ordering (load-bearing — mirrors the M05 design ordering doc
    // with the new features-index slot appended after the pack):
    //   1. Feature Pack body          — global project conventions
    //   2. Features index             — skill-style "what's available"
    //   3. Session Contract           — compliance reminder (always)
    //   4. Recent decisions           — situational awareness
    // Each block is independent: any missing block just doesn't surface.
    const blocks: string[] = [];
    if (featurePackBlock !== null) blocks.push(featurePackBlock);
    if (featuresIndexBlock !== null) blocks.push(featuresIndexBlock);
    blocks.push(M05_SESSION_CONTRACT);
    if (recentDecisionsBlock !== null) blocks.push(recentDecisionsBlock);
    const additionalContext = blocks.length > 0 ? blocks.join('\n\n---\n\n') : undefined;

    sessionStartLogger.info(
      {
        event: 'session_start_recorded',
        sessionId: event.sessionId,
        agentType: event.agentType,
        ...(projectId !== undefined ? { projectId } : {}),
        ...(slug !== undefined ? { projectSlug: slug } : {}),
        additionalContextBytes: typeof additionalContext === 'string' ? additionalContext.length : 0,
      },
      'SessionStart audit scheduled',
    );

    if (typeof additionalContext === 'string') {
      return { permissionDecision: 'allow', additionalContext };
    }
    return { permissionDecision: 'allow' };
  };
}
