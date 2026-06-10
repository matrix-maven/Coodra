import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { type PostgresHandle, postgresSchema, type SqliteHandle } from '@coodra/db';
import { createLogger, type Logger } from '@coodra/shared';
import { featuresRoot, renderFeatureMd } from '@coodra/shared/features';
import { sql } from 'drizzle-orm';

/**
 * Phase F.1 — render a stored frontmatter blob + body back to the
 * canonical feature.md markdown format.
 *
 * `features.frontmatter` is stored as either:
 *   - The raw YAML block the CLI parsed off disk (CLI write path),
 *     starting with a top-level key like `name:` — never wrapped in
 *     `---` fences (those are added by `renderFeatureMd`).
 *   - JSON-encoded frontmatter the web UI authored (web write path),
 *     an object like `{ "name": "...", "description": "...", ... }`.
 *
 * Heuristic: try JSON.parse first; if it returns a plain object with a
 * `name` field, render via the canonical `renderFeatureMd`. Otherwise
 * fall back to reconstituting the file as `---\n<frontmatter>\n---\n\n<body>`.
 * This is a graceful no-throw path — broken frontmatter still produces a
 * file the user can repair.
 */
function renderFeatureMarkdownFromStored(frontmatter: string, body: string): string {
  const trimmed = frontmatter.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj !== null && typeof obj === 'object' && typeof obj.name === 'string') {
        // Build the frontmatter object conditionally so we don't pass
        // explicit `undefined` for absent fields (exactOptionalPropertyTypes).
        const fm: {
          name: string;
          description: string;
          whenNotToUse?: string;
          maturity?: 'draft' | 'beta' | 'stable' | 'deprecated';
          owners?: ReadonlyArray<string>;
          tags?: ReadonlyArray<string>;
        } = {
          name: obj.name,
          description: typeof obj.description === 'string' ? obj.description : '',
        };
        if (typeof obj.whenNotToUse === 'string') fm.whenNotToUse = obj.whenNotToUse;
        if (
          obj.maturity === 'draft' ||
          obj.maturity === 'beta' ||
          obj.maturity === 'stable' ||
          obj.maturity === 'deprecated'
        ) {
          fm.maturity = obj.maturity;
        }
        if (Array.isArray(obj.owners)) {
          fm.owners = obj.owners.filter((v): v is string => typeof v === 'string');
        }
        if (Array.isArray(obj.tags)) {
          fm.tags = obj.tags.filter((v): v is string => typeof v === 'string');
        }
        return renderFeatureMd({ frontmatter: fm, body });
      }
    } catch {
      // Fall through to YAML-block path.
    }
  }
  // YAML block — reconstitute the file shape parseFeatureMd expects.
  const ensuredBodyTrailingNewline = body.endsWith('\n') ? body : `${body}\n`;
  return `---\n${trimmed}\n---\n\n${ensuredBodyTrailingNewline}`;
}

function safeReadUtf8(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Phase F.2 — parse the `feature_packs.content_json` envelope. Shape:
 *   { spec: string, implementation: string, techstack: string,
 *     meta: object | null, sourceFiles: string[] }
 * Defensive — malformed JSON returns null so the puller falls back to
 * DB-only sync (the pack is still findable, just not filesystem-mirrored).
 */
interface FeaturePackContentEnvelope {
  readonly spec: string;
  readonly implementation: string;
  readonly techstack: string;
  readonly meta: unknown;
  readonly sourceFiles: ReadonlyArray<string>;
}

function parseFeaturePackContent(raw: string): FeaturePackContentEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const spec = typeof obj.spec === 'string' ? obj.spec : '';
  const implementation = typeof obj.implementation === 'string' ? obj.implementation : '';
  const techstack = typeof obj.techstack === 'string' ? obj.techstack : '';
  const meta = obj.meta ?? null;
  const sourceFiles = Array.isArray(obj.sourceFiles)
    ? obj.sourceFiles.filter((v): v is string => typeof v === 'string')
    : [];
  if (spec.length === 0 && implementation.length === 0 && techstack.length === 0) return null;
  return { spec, implementation, techstack, meta, sourceFiles };
}

/**
 * Phase F.2 — write a pack file, OR write a `.cloud.<basename>` sidecar
 * when the local file is newer than the cloud row and the content differs.
 *
 * The sidecar shape uses the `<basename>.cloud.<ext>` convention so the
 * file ID is searchable and the extension is preserved (the web app's
 * pack detail page filters `*.cloud.md` for conflict banners; F.3.b
 * surfaces them). When local content matches cloud, this is a no-op so
 * idempotent re-ticks don't churn mtimes.
 *
 * The `<filename>` parameter is the canonical name on disk (spec.md,
 * implementation.md, techstack.md, meta.json). The sidecar inserts
 * `.cloud` before the final extension:
 *   spec.md            → spec.cloud.md
 *   implementation.md  → implementation.cloud.md
 *   meta.json          → meta.cloud.json
 */
function writePackFileOrSidecar(
  packDir: string,
  filename: string,
  cloudContent: string,
  cloudUpdatedAt: Date,
  log: Logger,
  slug: string,
): void {
  const path = join(packDir, filename);
  const sidecarName = filename.includes('.')
    ? `${filename.slice(0, filename.lastIndexOf('.'))}.cloud${filename.slice(filename.lastIndexOf('.'))}`
    : `${filename}.cloud`;
  const sidecarPath = join(packDir, sidecarName);
  if (!existsSync(path)) {
    try {
      writeFileSync(path, cloudContent, 'utf8');
    } catch (err) {
      log.warn(
        {
          event: 'team_rows_pack_fs_write_failed',
          slug,
          filename,
          err: err instanceof Error ? err.message : String(err),
        },
        'pack filesystem write failed',
      );
    }
    return;
  }
  let onDisk: string;
  let localMtime: Date;
  try {
    onDisk = readFileSync(path, 'utf8');
    localMtime = statSync(path).mtime;
  } catch (err) {
    log.warn(
      { event: 'team_rows_pack_fs_read_failed', slug, filename, err: err instanceof Error ? err.message : String(err) },
      'pack filesystem read failed — skipping conflict check',
    );
    return;
  }
  if (onDisk === cloudContent) {
    // Already in sync — no-op. Also clean up any stale sidecar.
    if (existsSync(sidecarPath)) {
      try {
        // Stale sidecar from a previous conflict that's now resolved
        // (file matches cloud again). Best-effort delete; ignore errors.
        unlinkSync(sidecarPath);
        log.info({ event: 'team_rows_pack_sidecar_cleared', slug, filename }, 'cleared resolved conflict sidecar');
      } catch {
        // ignore
      }
    }
    return;
  }
  // Content differs. Decide based on mtime: cloud newer → overwrite;
  // local newer → sidecar.
  if (cloudUpdatedAt.getTime() >= localMtime.getTime()) {
    try {
      writeFileSync(path, cloudContent, 'utf8');
      log.info(
        { event: 'team_rows_pack_overwritten', slug, filename, cloudUpdatedAt: cloudUpdatedAt.toISOString() },
        'cloud version is newer; overwrote local pack file',
      );
    } catch (err) {
      log.warn(
        {
          event: 'team_rows_pack_fs_write_failed',
          slug,
          filename,
          err: err instanceof Error ? err.message : String(err),
        },
        'pack filesystem overwrite failed',
      );
    }
  } else {
    try {
      writeFileSync(sidecarPath, cloudContent, 'utf8');
      log.info(
        {
          event: 'team_rows_pack_conflict_sidecar_written',
          slug,
          filename,
          sidecar: sidecarName,
          localMtime: localMtime.toISOString(),
          cloudUpdatedAt: cloudUpdatedAt.toISOString(),
        },
        'local pack file is newer than cloud; wrote .cloud sidecar instead of overwriting',
      );
    } catch (err) {
      log.warn(
        {
          event: 'team_rows_pack_sidecar_write_failed',
          slug,
          filename,
          err: err instanceof Error ? err.message : String(err),
        },
        'pack sidecar write failed',
      );
    }
  }
}

/**
 * `apps/sync-daemon/src/lib/team-rows-puller.ts` — Module 04 Phase 4.
 *
 * Cloud → local poller for the append-only tables that need to be
 * visible to local consumers (M05 recent-decisions injection, the
 * MCP `query_decisions` tool, the auto-context-pack diff section).
 *
 * Three tables on the same pattern:
 *   - `decisions`     — newer-than-local-max(created_at) wins.
 *   - `context_packs` — newer-than-local-max(created_at) wins.
 *   - `run_events`    — newer-than-local-max(created_at) wins.
 *
 * Each table is append-only (ADR-007), so the pull is conflict-free:
 * INSERT ON CONFLICT (id) DO NOTHING. Upserts that mutate fields are
 * not possible here (the source rows never change after insert).
 *
 * Caveat — when a team-mate writes a decision and the decision's run_id
 * references a runs row not yet pulled locally, the FK lookup
 * (`run_id` references `runs(id)`) silently fails because `runs.run_id`
 * is `ON DELETE SET NULL` and not enforced on insert. For v1 we accept
 * this — the local consumer's `query_decisions` tool will see the row
 * with `runId=null` until the runs row arrives on a subsequent tick.
 * Future tightening: order pull-table sequence so `runs` arrives
 * first, then dependents.
 *
 * Caveat — these helpers do NOT yet scope by org. They pull every row
 * from cloud whose timestamp is newer than the local high-water-mark.
 * In the team-cloud architecture each developer's local SQLite is
 * scoped to their active org by `projects.org_id` FK chain, but cloud
 * rows for OTHER orgs the developer is a member of would also flow
 * in here. v1 assumes one active org per machine; multi-org scope is a
 * follow-on (multi-org context switch needs design work in M04 too).
 */

const PULL_CHUNK_SIZE = 500;

export interface TeamRowsPullerDeps {
  readonly localDb: SqliteHandle;
  readonly cloudDb: PostgresHandle;
  readonly intervalMs?: number;
  readonly logger?: Logger;
  /**
   * When true, the puller does NOT auto-fire an initial tick. Tests
   * use this to keep `tickOnce` invocations deterministic — otherwise
   * the auto-tick races against the test's manual tick and assertions
   * about "newly pulled rows" become flaky. Defaults to false in
   * production.
   */
  readonly skipInitialTick?: boolean;
}

export interface TeamRowsPullerHandle {
  readonly stop: () => Promise<void>;
  readonly tickOnce: () => Promise<TeamRowsPullSummary>;
}

export interface TeamRowsPullSummary {
  readonly projects: number;
  readonly decisions: number;
  readonly contextPacks: number;
  readonly runEvents: number;
  readonly runs: number;
  /**
   * Phase F.1 — features pulled from cloud Postgres on this tick. Counts
   * the number of cloud features rows whose checksum differed from the
   * local SQLite row (i.e. new arrivals + cloud-side updates). Pure
   * idempotent re-pulls of unchanged rows contribute 0 to this count.
   */
  readonly features: number;
  /**
   * Phase F.2 — feature_packs pulled from cloud Postgres on this tick.
   * Same checksum-anti-loop semantics as features; counts cloud rows
   * whose `checksum` column differed from the local mirror.
   */
  readonly featurePacks: number;
  /**
   * Module 10 — Deep Wiki structure rows pulled this tick (cloud rows
   * whose updated_at was newer than the local mirror's).
   */
  readonly wikis: number;
  /** Module 10 — Deep Wiki page rows pulled this tick. */
  readonly wikiPages: number;
}

const ZERO_SUMMARY: TeamRowsPullSummary = Object.freeze({
  projects: 0,
  decisions: 0,
  contextPacks: 0,
  runEvents: 0,
  runs: 0,
  features: 0,
  featurePacks: 0,
  wikis: 0,
  wikiPages: 0,
});

export function createTeamRowsPuller(deps: TeamRowsPullerDeps): TeamRowsPullerHandle {
  if (deps.localDb.kind !== 'sqlite') {
    throw new TypeError('createTeamRowsPuller: localDb must be a SqliteHandle');
  }
  if (deps.cloudDb.kind !== 'postgres') {
    throw new TypeError('createTeamRowsPuller: cloudDb must be a PostgresHandle');
  }
  const log = deps.logger ?? createLogger('sync-daemon.team-rows-puller');
  const intervalMs = deps.intervalMs ?? 10_000;
  const localDb = deps.localDb;
  const cloudDb = deps.cloudDb;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  /**
   * Pull `projects` first — every other team table FKs to projects.id.
   * Without this, when a teammate's machine first syncs, every runs
   * row whose project the teammate hasn't separately registered will
   * fail the local FK constraint and never land. Closes the Bob-can't-
   * see-admin's-data gap from the M04 Phase 4 demo.
   *
   * Pulls every non-solo project (org_id != '__solo__'). The local
   * SQLite is per-machine + per-active-team, so all team projects are
   * fair game. ON CONFLICT (id) DO UPDATE refreshes name/cwd if the
   * cloud row drifted (e.g. another teammate ran ensureProject with a
   * different cwd backfill).
   */
  async function pullProjects(): Promise<number> {
    const ct = postgresSchema.projects;
    let cloudRows: Array<typeof ct.$inferSelect>;
    try {
      cloudRows = await cloudDb.db.select().from(ct).limit(PULL_CHUNK_SIZE);
    } catch (err) {
      log.warn(
        { event: 'team_rows_projects_pull_failed', err: err instanceof Error ? err.message : String(err) },
        'cloud SELECT projects threw — will retry next tick',
      );
      return 0;
    }
    if (cloudRows.length === 0) return 0;
    let inserted = 0;
    for (const row of cloudRows) {
      // Skip the global sentinel — every local already seeded it via
      // ensureGlobalProject, and the org_id may be different shape.
      if (row.id === '__global__') continue;
      // Skip solo-only projects (e.g. another machine's __solo__ rows
      // accidentally pushed). Team mode uses the team's clerk org id.
      if (row.orgId === '__solo__') continue;
      try {
        // ON CONFLICT DO NOTHING — keeps the count of "newly pulled
        // rows" honest (existing rows report changes=0). Project name
        // / cwd evolution from cloud is intentionally NOT propagated
        // for v1; if a teammate renames a project in the web UI,
        // other members re-init to pick it up. Append-only-ish
        // semantics match the rest of the team-rows pipeline.
        const stmt = localDb.raw.prepare(`
          INSERT INTO projects
            (id, slug, org_id, name, cwd, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `);
        const r = stmt.run(
          row.id,
          row.slug,
          row.orgId,
          row.name,
          row.cwd,
          Math.floor(row.createdAt.getTime() / 1000),
          Math.floor(row.updatedAt.getTime() / 1000),
        );
        if (r.changes > 0) inserted += 1;
      } catch (err) {
        log.warn(
          {
            event: 'team_rows_projects_insert_failed',
            projectId: row.id,
            slug: row.slug,
            err: err instanceof Error ? err.message : String(err),
          },
          'local projects insert threw — will re-pull next tick',
        );
      }
    }
    return inserted;
  }

  /**
   * Pull `runs` first because `decisions`, `context_packs`, and
   * `run_events` all FK to `runs.id`. ON CONFLICT DO NOTHING handles
   * the case where the runs row already exists locally (a teammate's
   * runs row that we created on this machine — impossible since runs
   * are per-machine — or our own runs row already inserted via the
   * audit outbox); the dependent inserts that follow find the row.
   */
  async function pullRuns(): Promise<number> {
    const ct = postgresSchema.runs;
    let cloudRows: Array<typeof ct.$inferSelect>;
    try {
      // No high-water-mark filter: when local activity creates a newer
      // row before cloud rows have been pulled, the `gt(started_at,
      // local_max)` filter would skip older cloud rows forever (the
      // bug Bob hit when his bridge implicitly opened a session and
      // bumped local max past the cloud row's created_at). Pull the
      // most recent N rows and rely on id-uniqueness via ON CONFLICT
      // DO NOTHING for dedup.
      cloudRows = await cloudDb.db.select().from(ct).orderBy(sql`${ct.startedAt} DESC`).limit(PULL_CHUNK_SIZE);
    } catch (err) {
      log.warn(
        { event: 'team_rows_runs_pull_failed', err: err instanceof Error ? err.message : String(err) },
        'cloud SELECT runs threw — will retry next tick',
      );
      return 0;
    }
    if (cloudRows.length === 0) return 0;
    let inserted = 0;
    for (const row of cloudRows) {
      try {
        const stmt = localDb.raw.prepare(`
          INSERT INTO runs
            (id, project_id, session_id, agent_type, mode, status,
             issue_ref, pr_ref, base_sha, created_by_user_id, started_at, ended_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `);
        const r = stmt.run(
          row.id,
          row.projectId,
          row.sessionId,
          row.agentType,
          row.mode,
          row.status,
          row.issueRef,
          row.prRef,
          row.baseSha,
          row.createdByUserId,
          Math.floor(row.startedAt.getTime() / 1000),
          row.endedAt === null ? null : Math.floor(row.endedAt.getTime() / 1000),
        );
        if (r.changes > 0) inserted += 1;
      } catch (err) {
        log.warn(
          {
            event: 'team_rows_runs_insert_failed',
            runId: row.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'local runs insert threw — will re-pull next tick',
        );
      }
    }
    return inserted;
  }

  async function pullDecisions(): Promise<number> {
    const ct = postgresSchema.decisions;
    let cloudRows: Array<typeof ct.$inferSelect>;
    try {
      // See pullRuns for why no high-water-mark filter.
      cloudRows = await cloudDb.db.select().from(ct).orderBy(sql`${ct.createdAt} DESC`).limit(PULL_CHUNK_SIZE);
    } catch (err) {
      log.warn(
        { event: 'team_rows_decisions_pull_failed', err: err instanceof Error ? err.message : String(err) },
        'cloud SELECT decisions threw — will retry next tick',
      );
      return 0;
    }
    if (cloudRows.length === 0) return 0;
    let inserted = 0;
    for (const row of cloudRows) {
      try {
        const stmt = localDb.raw.prepare(`
          INSERT INTO decisions
            (id, idempotency_key, run_id, description, rationale, alternatives,
             context, impact, confidence, reversible, created_by_user_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(idempotency_key) DO NOTHING
        `);
        const r = stmt.run(
          row.id,
          row.idempotencyKey,
          row.runId,
          row.description,
          row.rationale,
          row.alternatives,
          row.context,
          row.impact,
          row.confidence,
          row.reversible === null ? null : row.reversible ? 1 : 0,
          row.createdByUserId,
          Math.floor(row.createdAt.getTime() / 1000),
        );
        if (r.changes > 0) inserted += 1;
      } catch (err) {
        log.warn(
          {
            event: 'team_rows_decisions_insert_failed',
            decisionId: row.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'local decisions insert threw — will re-pull next tick',
        );
      }
    }
    return inserted;
  }

  async function pullContextPacks(): Promise<number> {
    const ct = postgresSchema.contextPacks;
    let cloudRows: Array<typeof ct.$inferSelect>;
    try {
      // See pullRuns for why no high-water-mark filter.
      cloudRows = await cloudDb.db.select().from(ct).orderBy(sql`${ct.createdAt} DESC`).limit(PULL_CHUNK_SIZE);
    } catch (err) {
      log.warn(
        { event: 'team_rows_context_packs_pull_failed', err: err instanceof Error ? err.message : String(err) },
        'cloud SELECT context_packs threw — will retry next tick',
      );
      return 0;
    }
    if (cloudRows.length === 0) return 0;
    let inserted = 0;
    for (const row of cloudRows) {
      try {
        const stmt = localDb.raw.prepare(`
          INSERT INTO context_packs
            (id, run_id, project_id, title, content, content_excerpt,
             source, meta, created_by_user_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO NOTHING
        `);
        const r = stmt.run(
          row.id,
          row.runId,
          row.projectId,
          row.title,
          row.content,
          row.contentExcerpt,
          row.source,
          row.meta,
          row.createdByUserId,
          Math.floor(row.createdAt.getTime() / 1000),
        );
        if (r.changes > 0) inserted += 1;
      } catch (err) {
        log.warn(
          {
            event: 'team_rows_context_packs_insert_failed',
            contextPackId: row.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'local context_packs insert threw — will re-pull next tick',
        );
      }
    }
    return inserted;
  }

  async function pullRunEvents(): Promise<number> {
    const ct = postgresSchema.runEvents;
    let cloudRows: Array<typeof ct.$inferSelect>;
    try {
      // See pullRuns for why no high-water-mark filter.
      cloudRows = await cloudDb.db.select().from(ct).orderBy(sql`${ct.createdAt} DESC`).limit(PULL_CHUNK_SIZE);
    } catch (err) {
      log.warn(
        { event: 'team_rows_run_events_pull_failed', err: err instanceof Error ? err.message : String(err) },
        'cloud SELECT run_events threw — will retry next tick',
      );
      return 0;
    }
    if (cloudRows.length === 0) return 0;
    let inserted = 0;
    for (const row of cloudRows) {
      try {
        const stmt = localDb.raw.prepare(`
          INSERT INTO run_events
            (id, run_id, phase, tool_name, tool_use_id, tool_input, outcome, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `);
        const r = stmt.run(
          row.id,
          row.runId,
          row.phase,
          row.toolName,
          row.toolUseId,
          row.toolInput,
          row.outcome,
          Math.floor(row.createdAt.getTime() / 1000),
        );
        if (r.changes > 0) inserted += 1;
      } catch (err) {
        log.warn(
          {
            event: 'team_rows_run_events_insert_failed',
            eventId: row.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'local run_events insert threw — will re-pull next tick',
        );
      }
    }
    return inserted;
  }

  /**
   * Phase F.1 — features pull.
   *
   * Cloud `features` rows → local SQLite mirror + filesystem writeback
   * to `<projects.cwd>/docs/features/<slug>/feature.md` for any feature
   * with `status='published'`. The filesystem write is what makes the
   * MCP `list_features` / `get_feature` tools (which read off disk)
   * see new features within ~10s of any teammate authoring them — the
   * "knowledge artifacts are git-distributed not Coodra-distributed"
   * gap from Phase E's demo audit.
   *
   * Anti-loop guard: when the local DB row's checksum matches the
   * cloud row's checksum, BOTH the DB upsert and the FS write are
   * skipped. Otherwise a teammate's CLI `feature add` (which writes
   * local DB → enqueues push → cloud INSERTs) would tick around and
   * pull its own write back to FS on the next interval, potentially
   * clobbering local edits.
   *
   * Draft handling (Phase F.3 forward-compat): rows with `status='draft'`
   * are upserted into local DB so the web UI can render them, but the
   * filesystem is left alone. Drafts never reach an agent. F.3 layers
   * MCP-handler-side filtering on top of this for defense-in-depth.
   *
   * Conflict resolution (F.2): when the local file's mtime exceeds the
   * cloud row's `updated_at` AND the rendered cloud markdown differs
   * from the file's current contents, we write the cloud copy to a
   * `<slug>/feature.cloud.md` sidecar instead of overwriting and surface
   * a warning. F.1 implements the simpler "cloud wins on checksum
   * difference" path; F.2 layers the sidecar on top.
   */
  async function pullFeatures(): Promise<number> {
    const ct = postgresSchema.features;
    let cloudRows: Array<typeof ct.$inferSelect>;
    try {
      cloudRows = await cloudDb.db.select().from(ct).orderBy(sql`${ct.updatedAt} DESC`).limit(PULL_CHUNK_SIZE);
    } catch (err) {
      log.warn(
        { event: 'team_rows_features_pull_failed', err: err instanceof Error ? err.message : String(err) },
        'cloud SELECT features threw — will retry next tick',
      );
      return 0;
    }
    if (cloudRows.length === 0) return 0;
    let touched = 0;
    for (const row of cloudRows) {
      try {
        // Anti-loop: local checksum match → no DB write, no FS write.
        const localRow = localDb.raw
          .prepare('SELECT id, checksum FROM features WHERE project_id = ? AND slug = ? LIMIT 1')
          .get(row.projectId, row.slug) as { id: string; checksum: string } | undefined;
        if (localRow !== undefined && localRow.checksum === row.checksum) {
          continue;
        }
        // Upsert local DB row. ON CONFLICT (project_id, slug) is the
        // UNIQUE constraint from migration 0014. Cloud is authoritative
        // when checksums differ — the local mtime conflict path lives
        // in the filesystem-write block below (F.2 will tighten this).
        const upsertStmt = localDb.raw.prepare(`
          INSERT INTO features
            (id, project_id, slug, frontmatter, body, checksum, status,
             created_by_user_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, slug) DO UPDATE SET
            frontmatter = excluded.frontmatter,
            body = excluded.body,
            checksum = excluded.checksum,
            status = excluded.status,
            created_by_user_id = excluded.created_by_user_id,
            updated_at = excluded.updated_at
        `);
        upsertStmt.run(
          row.id,
          row.projectId,
          row.slug,
          row.frontmatter,
          row.body,
          row.checksum,
          row.status,
          row.createdByUserId,
          Math.floor(row.createdAt.getTime() / 1000),
          Math.floor(row.updatedAt.getTime() / 1000),
        );
        touched += 1;

        // Filesystem writeback — only for published features. Drafts
        // stay in DB until promoted.
        if (row.status !== 'published') continue;
        const projectRow = localDb.raw.prepare('SELECT cwd FROM projects WHERE id = ? LIMIT 1').get(row.projectId) as
          | { cwd: string | null }
          | undefined;
        if (projectRow === undefined || projectRow.cwd === null) {
          // No registered cwd — we can't safely write. The puller
          // skips silently; when the project registers a cwd (next
          // CLI/bridge interaction), the next tick will retry.
          continue;
        }
        const featureDir = join(featuresRoot(projectRow.cwd), row.slug);
        const featureMdPath = join(featureDir, 'feature.md');
        // Render the markdown from the stored frontmatter (YAML or
        // JSON-encoded) + body. We accept either shape so the CLI can
        // write the literal YAML it parsed off disk; rendering is only
        // needed when the web UI writes JSON-encoded frontmatter.
        const renderedMd = renderFeatureMarkdownFromStored(row.frontmatter, row.body);
        if (existsSync(featureMdPath)) {
          // Already-written file — only overwrite if contents differ.
          const onDisk = safeReadUtf8(featureMdPath);
          if (onDisk === renderedMd) continue;
        }
        try {
          mkdirSync(dirname(featureMdPath), { recursive: true });
          writeFileSync(featureMdPath, renderedMd, 'utf8');
          log.info(
            { event: 'team_rows_feature_written_to_fs', slug: row.slug, projectId: row.projectId, path: featureMdPath },
            'wrote pulled feature.md to filesystem',
          );
        } catch (err) {
          log.warn(
            {
              event: 'team_rows_feature_fs_write_failed',
              slug: row.slug,
              projectId: row.projectId,
              path: featureMdPath,
              err: err instanceof Error ? err.message : String(err),
            },
            'filesystem write of pulled feature failed — will retry next tick',
          );
        }
      } catch (err) {
        log.warn(
          {
            event: 'team_rows_features_insert_failed',
            slug: row.slug,
            projectId: row.projectId,
            err: err instanceof Error ? err.message : String(err),
          },
          'local features upsert threw — will re-pull next tick',
        );
      }
    }
    return touched;
  }

  /**
   * Phase F.2 — feature_packs pull.
   *
   * Cloud `feature_packs` rows → local SQLite mirror + filesystem
   * writeback to `<projects.cwd>/docs/feature-packs/<slug>/{spec.md,
   * implementation.md, techstack.md, meta.json}`. The four-file
   * filesystem layout is what the MCP `get_feature_pack` handler reads
   * and what the bridge SessionStart hook injects via
   * `additionalContext` (Pattern 20 / ADR-012).
   *
   * Project resolution: `feature_packs` is project-agnostic at the
   * schema level (no project_id FK), but the filesystem layout lives
   * under a project's cwd. The puller picks the FIRST registered
   * non-sentinel project's cwd as the write target — the same heuristic
   * the MCP-side reader uses today (see `apps/mcp-server/src/lib/
   * feature-pack.ts`). If no project is registered yet, the pull
   * touches DB only; the next tick after `coodra init` registers a
   * project will retry.
   *
   * Anti-loop: cloud checksum == local checksum → skip (no DB write,
   * no FS write).
   *
   * Conflict sidecar: if the local file's mtime is NEWER than the
   * cloud row's `updated_at` AND the file's content differs from
   * cloud, the cloud version is written to a `*.cloud.md` sidecar
   * (e.g. `spec.cloud.md`, `implementation.cloud.md`) instead of
   * overwriting. Surfaces in the web pack detail page (F.3.b will
   * add a banner; F.1 ships the sidecar files unannotated).
   *
   * Status='draft' rows: upserted into local DB so admin web UI can
   * render them, but the filesystem write is skipped — drafts stay
   * in DB until promoted. Symmetric with `pullFeatures`.
   */
  async function pullFeaturePacks(): Promise<number> {
    const ct = postgresSchema.featurePacks;
    let cloudRows: Array<typeof ct.$inferSelect>;
    try {
      cloudRows = await cloudDb.db.select().from(ct).orderBy(sql`${ct.updatedAt} DESC`).limit(PULL_CHUNK_SIZE);
    } catch (err) {
      log.warn(
        { event: 'team_rows_feature_packs_pull_failed', err: err instanceof Error ? err.message : String(err) },
        'cloud SELECT feature_packs threw — will retry next tick',
      );
      return 0;
    }
    if (cloudRows.length === 0) return 0;

    // Resolve a project cwd to write into. Pick the first non-sentinel
    // project — the heuristic is acceptable in v1 because feature_packs
    // is globally-scoped by slug; future "project-scoped pack" work
    // tightens this. Null cwd means we can't filesystem-write; DB-only.
    const targetCwd = localDb.raw
      .prepare(
        `SELECT cwd FROM projects
           WHERE org_id NOT IN ('__solo__', '__global__')
             AND cwd IS NOT NULL
           ORDER BY created_at ASC
           LIMIT 1`,
      )
      .get() as { cwd: string | null } | undefined;
    const projectCwd: string | null = targetCwd !== undefined ? targetCwd.cwd : null;

    let touched = 0;
    for (const row of cloudRows) {
      try {
        const localRow = localDb.raw
          .prepare('SELECT id, checksum FROM feature_packs WHERE slug = ? LIMIT 1')
          .get(row.slug) as { id: string; checksum: string } | undefined;
        if (localRow !== undefined && localRow.checksum === row.checksum) continue;

        const upsertStmt = localDb.raw.prepare(`
          INSERT INTO feature_packs
            (id, slug, parent_slug, is_active, checksum, created_by_user_id,
             content_json, status, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(slug) DO UPDATE SET
            parent_slug = excluded.parent_slug,
            is_active = excluded.is_active,
            checksum = excluded.checksum,
            created_by_user_id = excluded.created_by_user_id,
            content_json = excluded.content_json,
            status = excluded.status,
            updated_at = excluded.updated_at
        `);
        upsertStmt.run(
          row.id,
          row.slug,
          row.parentSlug,
          row.isActive ? 1 : 0,
          row.checksum,
          row.createdByUserId,
          row.contentJson,
          row.status,
          Math.floor(row.updatedAt.getTime() / 1000),
        );
        touched += 1;

        // Filesystem writeback — only for published packs with content.
        if (row.status !== 'published') continue;
        if (row.contentJson === null) continue;
        if (projectCwd === null) continue;
        const content = parseFeaturePackContent(row.contentJson);
        if (content === null) continue;

        const packDir = join(projectCwd, 'docs', 'feature-packs', row.slug);
        mkdirSync(packDir, { recursive: true });

        // Each file: write iff (file absent) OR (local mtime ≤ cloud
        // updatedAt AND content differs) — last-write-wins. Otherwise
        // (local mtime > cloud AND content differs) → sidecar.
        writePackFileOrSidecar(packDir, 'spec.md', content.spec, row.updatedAt, log, row.slug);
        writePackFileOrSidecar(packDir, 'implementation.md', content.implementation, row.updatedAt, log, row.slug);
        writePackFileOrSidecar(packDir, 'techstack.md', content.techstack, row.updatedAt, log, row.slug);
        // Phase F.6 — meta.json carries the on-disk status flag for
        // the bridge SessionStart draft gate. Merge cloud status into
        // the cloud-supplied meta object so teammate filesystems
        // always have a current status field even if the upstream
        // meta came from a pre-Phase-F write that lacked it.
        const metaObj =
          content.meta !== null && typeof content.meta === 'object'
            ? { ...(content.meta as Record<string, unknown>), status: row.status }
            : { slug: row.slug, parentSlug: row.parentSlug ?? null, status: row.status };
        const metaText = `${JSON.stringify(metaObj, null, 2)}\n`;
        writePackFileOrSidecar(packDir, 'meta.json', metaText, row.updatedAt, log, row.slug);
      } catch (err) {
        log.warn(
          {
            event: 'team_rows_feature_packs_insert_failed',
            slug: row.slug,
            err: err instanceof Error ? err.message : String(err),
          },
          'local feature_packs upsert threw — will re-pull next tick',
        );
      }
    }
    return touched;
  }

  /**
   * Module 10 — wikis pull. Cloud `wikis` → local SQLite mirror, so the
   * laptop-team web render and `coodra wiki status/list` see teammate-
   * authored wikis. Mutable (a re-plan replaces structure_json), so
   * ON CONFLICT(id) DO UPDATE — but only when the cloud row is newer than
   * the local mirror (`updated_at`), which also prevents a machine from
   * clobbering its own freshly-authored wiki with its own pushed-back copy.
   *
   * No high-water-mark filter (same rationale as pullRuns). FK to runs is
   * not enforced on insert in the daemon's local handle (foreign_keys off),
   * matching pullDecisions; a missing generated_by_run_id just stays
   * dangling until the run arrives.
   */
  async function pullWikis(): Promise<number> {
    const ct = postgresSchema.wikis;
    let cloudRows: Array<typeof ct.$inferSelect>;
    try {
      cloudRows = await cloudDb.db.select().from(ct).orderBy(sql`${ct.updatedAt} DESC`).limit(PULL_CHUNK_SIZE);
    } catch (err) {
      log.warn(
        { event: 'team_rows_wikis_pull_failed', err: err instanceof Error ? err.message : String(err) },
        'cloud SELECT wikis threw — will retry next tick',
      );
      return 0;
    }
    if (cloudRows.length === 0) return 0;
    let touched = 0;
    for (const row of cloudRows) {
      try {
        const cloudUpdated = Math.floor(row.updatedAt.getTime() / 1000);
        const localRow = localDb.raw.prepare('SELECT updated_at FROM wikis WHERE id = ? LIMIT 1').get(row.id) as
          | { updated_at: number }
          | undefined;
        if (localRow !== undefined && localRow.updated_at >= cloudUpdated) continue; // local same-or-newer
        const stmt = localDb.raw.prepare(`
          INSERT INTO wikis
            (id, project_id, slug, title, description, mode, schema_version,
             structure_json, generated_by_run_id, created_by_user_id, org_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            mode = excluded.mode,
            schema_version = excluded.schema_version,
            structure_json = excluded.structure_json,
            generated_by_run_id = excluded.generated_by_run_id,
            created_by_user_id = excluded.created_by_user_id,
            org_id = excluded.org_id,
            updated_at = excluded.updated_at
        `);
        const r = stmt.run(
          row.id,
          row.projectId,
          row.slug,
          row.title,
          row.description,
          row.mode,
          row.schemaVersion,
          row.structureJson,
          row.generatedByRunId,
          row.createdByUserId,
          row.orgId,
          Math.floor(row.createdAt.getTime() / 1000),
          cloudUpdated,
        );
        if (r.changes > 0) touched += 1;
      } catch (err) {
        log.warn(
          {
            event: 'team_rows_wikis_insert_failed',
            wikiId: row.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'local wikis upsert threw — will re-pull next tick',
        );
      }
    }
    return touched;
  }

  /**
   * Module 10 — wiki_pages pull. Cloud `wiki_pages` → local mirror.
   * Mutable (authoring flips state + body), ON CONFLICT(wiki_id, page_id)
   * DO UPDATE, gated on cloud `updated_at` newer than local. Runs after
   * pullWikis so the parent wiki row exists locally.
   */
  async function pullWikiPages(): Promise<number> {
    const ct = postgresSchema.wikiPages;
    let cloudRows: Array<typeof ct.$inferSelect>;
    try {
      cloudRows = await cloudDb.db.select().from(ct).orderBy(sql`${ct.updatedAt} DESC`).limit(PULL_CHUNK_SIZE);
    } catch (err) {
      log.warn(
        { event: 'team_rows_wiki_pages_pull_failed', err: err instanceof Error ? err.message : String(err) },
        'cloud SELECT wiki_pages threw — will retry next tick',
      );
      return 0;
    }
    if (cloudRows.length === 0) return 0;
    let touched = 0;
    for (const row of cloudRows) {
      try {
        const cloudUpdated = Math.floor(row.updatedAt.getTime() / 1000);
        const localRow = localDb.raw
          .prepare('SELECT updated_at FROM wiki_pages WHERE wiki_id = ? AND page_id = ? LIMIT 1')
          .get(row.wikiId, row.pageId) as { updated_at: number } | undefined;
        if (localRow !== undefined && localRow.updated_at >= cloudUpdated) continue;
        const stmt = localDb.raw.prepare(`
          INSERT INTO wiki_pages
            (id, wiki_id, page_id, state, content_markdown, citations,
             authored_by_run_id, created_by_user_id, org_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(wiki_id, page_id) DO UPDATE SET
            state = excluded.state,
            content_markdown = excluded.content_markdown,
            citations = excluded.citations,
            authored_by_run_id = excluded.authored_by_run_id,
            created_by_user_id = excluded.created_by_user_id,
            org_id = excluded.org_id,
            updated_at = excluded.updated_at
        `);
        const r = stmt.run(
          row.id,
          row.wikiId,
          row.pageId,
          row.state,
          row.contentMarkdown,
          row.citations,
          row.authoredByRunId,
          row.createdByUserId,
          row.orgId,
          Math.floor(row.createdAt.getTime() / 1000),
          cloudUpdated,
        );
        if (r.changes > 0) touched += 1;
      } catch (err) {
        log.warn(
          {
            event: 'team_rows_wiki_pages_insert_failed',
            pageRowId: row.id,
            err: err instanceof Error ? err.message : String(err),
          },
          'local wiki_pages upsert threw — will re-pull next tick',
        );
      }
    }
    return touched;
  }

  async function tickOnce(): Promise<TeamRowsPullSummary> {
    // Order matters — projects first (everything FKs to projects.id),
    // then runs (decisions/context_packs/run_events FK to runs.id),
    // then the three append-only dependent tables in parallel.
    // ON CONFLICT DO NOTHING/DO UPDATE keeps the loop idempotent even
    // when a race re-inserts.
    //
    // Features + feature_packs (Phase F.1/F.2) FK only to projects (or
    // not at all in the pack case), so they run in parallel with the
    // run-dependent batch.
    const projects = await pullProjects();
    const runs = await pullRuns();
    // wikis must land before wiki_pages (the page FKs to wikis.id) — pull
    // them sequentially, then the rest of the dependent tables in parallel.
    const wikis = await pullWikis();
    const [decisions, contextPacks, runEvents, features, featurePacks, wikiPages] = await Promise.all([
      pullDecisions(),
      pullContextPacks(),
      pullRunEvents(),
      pullFeatures(),
      pullFeaturePacks(),
      pullWikiPages(),
    ]);
    const summary: TeamRowsPullSummary = {
      projects,
      runs,
      decisions,
      contextPacks,
      runEvents,
      features,
      featurePacks,
      wikis,
      wikiPages,
    };
    if (projects + runs + decisions + contextPacks + runEvents + features + featurePacks + wikis + wikiPages > 0) {
      log.info({ event: 'team_rows_pulled', ...summary }, 'team-rows pull tick complete');
    }
    return summary;
  }

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void tickOnce()
        .catch((err) => {
          log.warn(
            { event: 'team_rows_tick_threw', err: err instanceof Error ? err.message : String(err) },
            'tickOnce threw — will retry next interval',
          );
        })
        .finally(() => scheduleNext());
    }, intervalMs);
  }

  // Initial tick fires immediately — unless tests have explicitly
  // disabled it for determinism (otherwise the auto-tick races with
  // the test's manual tickOnce and "rows pulled" counts depend on
  // who reaches the cloud query first).
  if (deps.skipInitialTick === true) {
    scheduleNext();
    return {
      async stop(): Promise<void> {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
      },
      tickOnce,
    };
  }
  void tickOnce()
    .catch((err) => {
      log.warn(
        { event: 'team_rows_initial_tick_threw', err: err instanceof Error ? err.message : String(err) },
        'initial tickOnce threw',
      );
    })
    .finally(() => scheduleNext());

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
    tickOnce,
  };
}

export const ZERO_PULL_SUMMARY = ZERO_SUMMARY;
