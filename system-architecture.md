# Coodra v2 — System Architecture

> Ground-up design. Built on the 18 proven decisions from the prototype. Every trade-off named, every decision reasoned. No cargo-culted cloud patterns.

**Constraints locked via Q&A:**
- Solo mode = fully local (SQLite + sqlite-vec, zero external deps)
- Team mode = cloud sync as optional add-on (Postgres + pgvector + Redis)
- Same service codebase, different storage adapters per mode
- Agents: Claude Code + Windsurf (full hooks) + any MCP-capable agent (read path only)
- Graphify: external CLI, orchestrated as a subprocess by Coodra CLI
- LLM enrichment: Ollama local (default) + user API key override
- Auth: no auth in solo mode, Clerk JWT in team mode
- Cloud sync: REST batch (periodic HTTP POST)
- Scale target: 1–10 developers. Design for correctness, not throughput.

---

## 0. Corrections to the AI-Generated Plan

The previous AI plan was designed for a public SaaS at scale. Wrong mental model.

| AI plan said | Reality | Correction |
|---|---|---|
| Cloudflare CDN, WAF, DDoS protection | Local-first — no public endpoints in solo mode | CDN removed. CDN serves static assets to millions. Not applicable. |
| Fly.io multi-region, blue-green deploys | Scale target is 1–10 devs | Single-region, simple deploy. |
| Redis Sentinel, 3 nodes | Solo mode has no Redis at all | Solo: in-process SQLite queue. Team: Upstash serverless Redis (managed HA). |
| `p50 < 30ms` SLOs with error burn-rate monitoring | 1–10 devs, no on-call rotation | Latency targets yes. PagerDuty burn-rate tracking, no. |
| IVFFlat index on embeddings | Correct for Postgres team mode | Solo uses sqlite-vec (brute-force KNN by default; optional ANN indices as they mature). No IVFFlat config needed. |
| Partition `run_events` by month | Overkill at <1M rows | Index-only scans handle this for years at 1–10 devs. |
| Protobuf: "not yet" | Correct — but the threshold is >10K events/sec, not "not yet" | JSON everywhere. Explicit reasoning in §3. |
| PgBouncer in transaction mode | Supabase Supavisor already handles this | Already in prototype, unchanged. |

---

## 1. Two-Mode Architecture

```
┌─────────────────────────────────────────────────────────┐
│  SOLO MODE (default)                                      │
│  Everything on the developer's machine. Zero deps.        │
│                                                           │
│  Claude Code ──stdio──► MCP Server (:3100)               │
│  Windsurf    ──HTTP──► MCP Server (:3100)                │
│  Claude Code ──HTTP──► Hooks Bridge (:3101)              │
│  Windsurf    ──shell adapter──► Hooks Bridge (:3101)     │
│  Browser     ──HTTP──► Web App (:3000)                   │
│                                                           │
│  All services → SQLite WAL (~/.coodra/data.db)        │
│                 + sqlite-vec (cosine KNN, optional ANN)  │
│                 + in-process SQLite worker queue         │
│                                                           │
│  No Redis. No auth. No external network.                  │
└──────────────────────────┬──────────────────────────────┘
                           │
                    REST BATCH SYNC
                    (opt-in, every 30s)
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│  TEAM / CLOUD MODE (optional add-on)                      │
│  Local services STILL write to local SQLite.             │
│  Sync Daemon pushes unsynced records → cloud Postgres.   │
│  Cloud services (API, workers) use Postgres directly.    │
│  Clerk JWT auth required on cloud API routes             │
│                                                           │
│  Cloud (Railway/Fly.io single-region):                   │
│    Web App | BullMQ Workers | Upstash Redis              │
│    Supabase Postgres (HA managed)                        │
└─────────────────────────────────────────────────────────┘
```

**Mode detection:** Each service reads `COODRA_MODE` from `.env` or `~/.coodra/config.json`. In both solo and team modes, **local services always write to local SQLite** — the storage adapter returned by `createDb()` is always `better-sqlite3` on the developer's machine. `team` mode adds the Sync Daemon (which has its own Postgres connection for pushing unsynced records to the cloud) and switches the **cloud-deployed services** (cloud API, BullMQ workers) to use Postgres. All local service logic is identical across modes; only the cloud services differ.

**What "local services always write to local SQLite" means in code (Module 03 S4 / verification F11):** `apps/mcp-server/src/lib/db.ts` and `apps/hooks-bridge/src/lib/db.ts` both pass `kind: 'local'` to `@coodra/db::createDb` unconditionally. There is **no env knob, no flag, no boot path** that gives either binary a Postgres handle. The Module 02 stop-gap `COODRA_DB_OVERRIDE_MODE` was removed in M03 S4. Cloud writes are owned exclusively by the future Sync Daemon and Module 05 NL Assembly's embeddings-ingest worker — services that don't exist yet. If a future verification brief or test asks to "boot the binary against Postgres," that's a category error: the binaries are SQLite-only by design, and the integration is exercised through `@coodra/db`'s own `kind: 'cloud'` test path (`packages/db/__tests__/integration/cloud-mode-write.test.ts`).

---

## 2. Service Inventory

| Service | Solo | Team | Lang | Framework | Port |
|---|---|---|---|---|---|
| MCP Server | local (stdio + HTTP) | local (HTTP :3100) | TypeScript | Express + MCP SDK | 3100 |
| Hooks Bridge | local (HTTP :3101) | local (HTTP :3101) | TypeScript | Hono | 3101 |
| Web App | local (:3000) | local (:3000) + cloud-deployed | TypeScript | Next.js 15 | 3000 |
| Run Diff | in-process (mcp-server) | in-process (mcp-server) | TypeScript | `git diff` subprocess | — |
| Sync Daemon | absent | background process | TypeScript | Node.js | — |
| Workers | in-process (SQLite queue) | BullMQ (Upstash Redis) | TypeScript | BullMQ | — |

**Notes on the post-Module-04-Phase-4 inventory:**
- The original Python services (`Semantic Diff` :3201 and `NL Assembly` :3200) are **gone**. Module 05 reshape (2026-05-08) replaced NL Assembly with the agent-driven retrieval tools `list_context_packs` + `read_context_pack`. Module 06 (Run Diff, 2026-05-09) replaced Semantic Diff with an in-process TypeScript runner using `git diff` (no AST parsing, no LLM enrichment). See ADR-013.
- The **Hooks Bridge runs locally in both modes** — there is no cloud-deployed bridge. Module 04 Phase 4 (Caveat 2 fix) confirmed that pushing the bridge to cloud added latency and a new failure mode without a real benefit. Local audit writes flow through the durable outbox to the sync-daemon, which pushes them to cloud Postgres asynchronously. The `LOCAL_HOOK_SECRET` (formerly billed as the auth token for cloud-bridge HTTP calls) is now solely the credential for the local sync-daemon's cloud-API calls.

**Key change from prototype:** In solo mode, workers run in-process within the Hooks Bridge using a SQLite-backed job queue. In team mode, the queue backend switches to BullMQ + Redis. The same processor function signatures are used in both modes — only the queue driver changes.

**Web App in team mode:** Developers can still open `http://localhost:3000` against their local SQLite (offline-first), and tech leads use `https://app.coodra.dev` backed by cloud Postgres. Both instances run the same Next.js build; the storage adapter (solo SQLite vs. team Postgres) is selected by `COODRA_MODE` + environment.

---

## 3. Data in Motion

### 3.1 Wire Format: JSON Everywhere

**Decision: JSON, not Protobuf, not MessagePack.**

- Hook payloads are ~1–5 KB. Protobuf saves ~30% on 2 KB = 600 bytes. Irrelevant.
- Agents emit JSON natively. Normalizing to Protobuf internally then back to JSON adds a build step (`.proto` files, code generation) for a problem that doesn't exist.
- JSON is human-readable. At 1–10 developers debugging their own hooks, readability is worth more than wire efficiency.
- **Reconsider Protobuf when:** sustained throughput exceeds 10,000 events/second with measurable serialization CPU. That threshold is orders of magnitude beyond the design target.

### 3.2 Claude Code Hook Payload Shape

Claude Code fires hooks as HTTP POST to the adapter script's target URL. Payload:
```json
{
  "hook_event_name": "PreToolUse",
  "session_id": "abc123",
  "tool_name": "Write",
  "tool_input": { "file_path": "src/auth.ts", "content": "..." },
  "tool_use_id": "tool-uuid-456",
  "cwd": "/home/dev/myapp"
}
```
To **block**: respond with `{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "..." } }`.
To **allow**: respond with `{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow" } }`.

### 3.3 Windsurf Cascade Hook Payload Shape

Windsurf fires hooks as **shell commands** (not HTTP). The hook receives JSON on stdin. Windsurf exposes 12 hook events total; Coodra maps the 9 that carry information about tool-use and session boundaries. The remaining 3 (`post_read_code`, `post_user_prompt`, `pre_cascade_response`) are ignored by default because they add noise without changing the run record — you can wire them later if you need finer traces.

| Windsurf event | Maps to Coodra event | Blockable? |
|---|---|---|
| `pre_write_code` | `pre_tool_use` (tool: Edit/Write) | Yes — exit code 2 ¹ |
| `pre_run_command` | `pre_tool_use` (tool: Bash) | Yes — exit code 2 ¹ |
| `pre_mcp_tool_use` | `pre_tool_use` (tool: MCP:*) | Yes — exit code 2 ¹ |
| `pre_read_code` | `pre_tool_use` (tool: Read) | Yes — exit code 2 ¹ |
| `pre_user_prompt` | (governance layer, not tracked) | Yes — exit code 2 ¹ |
| `post_write_code` | `post_tool_use` | No |
| `post_run_command` | `post_tool_use` | No |
| `post_mcp_tool_use` | `post_tool_use` | No |
| `post_cascade_response` | `session_end` proxy | No |
| `post_read_code`, `post_user_prompt`, `pre_cascade_response` | _not mapped_ (see above) | n/a |

¹ Exit code 2 = block is specified in the official Windsurf Cascade Hooks documentation ([docs.windsurf.com/windsurf/cascade/hooks](https://docs.windsurf.com/windsurf/cascade/hooks)). Exit code 0 = allow. Any other non-zero code = error but action proceeds (same as allow). Only pre-hooks can block.

Windsurf hook payload structure:
```json
{
  "agent_action_name": "pre_write_code",
  "trajectory_id": "traj-abc123",
  "execution_id": "exec-xyz789",
  "timestamp": "2026-04-16T10:00:00Z",
  "model_name": "Claude Sonnet 4",
  "tool_info": {
    "file_path": "src/auth.ts",
    "edits": [{ "old_string": "...", "new_string": "..." }]
  }
}
```

`trajectory_id` = session ID (maps to Claude Code's `session_id`).
`execution_id` = turn ID (maps to Claude Code's `tool_use_id`).

**Windsurf adapter shell script** (`~/.windsurf/hooks/coodra.sh`):
```bash
#!/bin/bash
PAYLOAD=$(cat)
RESPONSE=$(echo "$PAYLOAD" | curl -s -X POST \
  "http://localhost:3101/v1/hooks/windsurf" \
  -H "Content-Type: application/json" \
  --data-binary @-)
DECISION=$(echo "$RESPONSE" | python3 -c \
  "import sys,json; print(json.load(sys.stdin).get('decision','allow'))")
if [ "$DECISION" = "deny" ]; then
  echo "$RESPONSE" | python3 -c \
    "import sys,json; print(json.load(sys.stdin).get('reason','Blocked by policy'))" >&2
  exit 2
fi
exit 0
```

The shell script is the **only agent-specific code outside the adapter layer**. Everything downstream of `POST /v1/hooks/windsurf` is agent-agnostic.

### 3.4 Normalized Internal HookEvent

Both Claude Code and Windsurf payloads are normalized at ingress before any business logic:

```typescript
interface HookEvent {
  agentType: 'claude_code' | 'windsurf' | 'unknown';
  eventPhase: 'pre' | 'post' | 'session_start' | 'session_end';
  sessionId: string;        // trajectory_id (Windsurf) | session_id (Claude Code)
  turnId?: string;          // execution_id (Windsurf) | tool_use_id (Claude Code)
  toolName: string;         // normalized: Write | Edit | Bash | Read | MCP:github | etc.
  filePath?: string;        // extracted from tool_info
  toolInput: unknown;
  cwd?: string;
  projectSlug?: string;     // from .coodra.json if present
}
```

### 3.5 MCP Transport: stdio + HTTP

**Two transports, one server:**

```
stdio (Claude Code):
  Agent spawns: node ~/.coodra/bin/mcp-server.js
  Communication: JSON-RPC 2.0 over stdin/stdout
  Framing: Content-Length header + \r\n\r\n (LSP-style, exact spec)
  Critical: NO stray output on stdout — any non-JSON-RPC bytes corrupt the stream
  Latency: zero network, sub-millisecond

Streamable HTTP :3100 (Windsurf, VS Code Copilot, any HTTP MCP client):
  Agent connects to: http://localhost:3100
  Transport: MCP Streamable HTTP (chunked HTTP streaming, per MCP 2025-03-26 spec)
  Note: this is NOT browser SSE — it is for agent processes only. Do not apply
        browser SSE semantics (auto-reconnect, EventSource API) here.
  Latency: loopback, ~1ms
```

**SSE is used only in the web dashboard** (`/api/runs/[id]/events`) for browser → server one-way event streaming. That SSE stream is separate from and unrelated to MCP transport.

Claude Code config (`.mcp.json` in project root):
```json
{ "mcpServers": { "coodra": { "type": "stdio", "command": "node", "args": ["~/.coodra/bin/mcp-server.js"] } } }
```

Windsurf config (`~/.windsurf/mcp_config.json`):
```json
{ "mcpServers": { "coodra": { "serverUrl": "http://localhost:3100" } } }
```

The MCP server process serves both simultaneously: a stdio handler (one goroutine per Claude Code spawn) and a persistent HTTP server on :3100.

### 3.6 SSE for Live Run Dashboard

The web app streams live run events via **SSE (Server-Sent Events)**, not WebSocket.

Why SSE not WebSocket:
- Data flows one direction: server → browser (run events as they are recorded)
- SSE has built-in browser reconnect; no client-side reconnection code needed
- SSE works over HTTP/1.1 with no upgrade handshake
- WebSocket's bidirectionality is wasted — the browser never sends data on this channel

The one place WebSocket would be correct: real-time bidirectional sync (cloud pushing new context packs to local). The REST batch sync (30s polling) makes this unnecessary at 1–10 devs.

**SSE browser limit:** Browsers cap ~6 concurrent SSE connections per origin. The current design opens 1 SSE stream per run detail page, which is safely within this limit. If you add additional SSE streams per page in the future (e.g., live Graphify updates alongside run events), track the total per-page SSE count and consolidate to a single multiplexed stream before hitting the ceiling.

### 3.7 Cloud Sync: REST Batch

When team mode is active, the Sync Daemon runs as a background process:

```
Every 30 seconds:
  SELECT * FROM local_records WHERE synced_at IS NULL LIMIT 100
  POST /api/sync { records: [...] }  →  cloud receives, deduplicates via idempotency keys
  On 200 OK: UPDATE local_records SET synced_at = now() WHERE id IN (...)
  On error: exponential backoff (30s → 60s → 120s, cap at 120s)
  Data is never dropped. Unsynced records stay in SQLite until ACK.
```

Sync direction:
- Local → cloud: runs, run_events, context_packs, policy_decisions
- Cloud → local: feature_packs, policy_rules (pull-on-interval, every 60s)

---

## 4. Data at Rest

### 4.1 Solo Mode: SQLite WAL + sqlite-vec

**Storage file:** `~/.coodra/data.db`

```sql
PRAGMA journal_mode = WAL;      -- concurrent readers + 1 writer
PRAGMA synchronous = NORMAL;    -- durable with WAL; no fsync on every write
PRAGMA cache_size = -64000;     -- 64 MB page cache in memory
PRAGMA foreign_keys = ON;
PRAGMA temp_store = MEMORY;
```

**Why SQLite WAL:** MCP server (reads) + Web App (reads) + Hooks Bridge (writes) coexist without contention. WAL allows concurrent readers while a single writer is active. No process blocks another. Zero setup — the file is created on first run.

**Vector search:** `sqlite-vec` extension loaded at connection open.

```sql
-- Loaded once at startup
SELECT load_extension('/path/to/vec0');

-- Virtual table with explicit cosine distance metric
CREATE VIRTUAL TABLE IF NOT EXISTS pack_embeddings USING vec0(
  pack_id TEXT PRIMARY KEY,
  embedding FLOAT[384] distance_metric=cosine   -- all-MiniLM-L6-v2, 384-dim
);

-- Query: top-5 nearest context packs to a query vector
SELECT pack_id, distance
FROM pack_embeddings
WHERE embedding MATCH ?         -- query vector as packed float32 blob
  AND k = 5
ORDER BY distance;
```

**sqlite-vec is a brute-force KNN engine by default** (exhaustive scan, O(n·d) per query). This is fast and correct for up to ~100K vectors; at 22 context packs it is effectively instant. ANN indices (IVF-style, HNSW-style) are an emerging optional feature in later sqlite-vec versions — not the default, and not universally available. Do not assume HNSW is always active. If you need guaranteed ANN behaviour, verify the installed sqlite-vec version supports `index_type='ivf'` or `index_type='hnsw'` and add explicit configuration. At the current scale (tens to low-thousands of packs), brute-force is the right choice: simpler, no tuning required.

**In-process worker queue (solo mode):**

```sql
CREATE TABLE IF NOT EXISTS pending_jobs (
  id          TEXT PRIMARY KEY,           -- UUID
  queue       TEXT NOT NULL,              -- 'record-run-event' | 'assemble-context-pack' | etc.
  payload     TEXT NOT NULL,              -- JSON
  attempts    INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'pending',     -- pending | processing | done | failed
  run_after   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX pending_jobs_poll_idx ON pending_jobs (queue, status, run_after);
```

A lightweight worker loop (`setInterval`, 500ms) polls this table, picks up pending jobs, runs the processor function, updates status. At 1–10 devs, this is more than sufficient. The same processor functions (from `assemble-context-pack.ts`, etc.) are reused in team mode with BullMQ — only the queue driver changes.

### 4.2 Team / Cloud Mode: Postgres + pgvector

**Same Drizzle schema.** The `createDb()` factory exists in two contexts:
- **Local services** (`hooks-bridge`, `mcp-server`, `web-app` in team mode on the developer's machine): always returns the `better-sqlite3` driver pointing to `~/.coodra/data.db`. Local services write to local SQLite in both solo and team modes.
- **Cloud services** (`cloud-api`, `bullmq-workers` deployed on Railway/Fly.io): returns the `postgres` driver pointing to Supabase. The cloud tier never touches local SQLite.

The Sync Daemon is a third context: it holds **two** connections simultaneously — `better-sqlite3` (to read unsynced records from local SQLite) and `postgres` (to write them to cloud Postgres). It is the only process that holds both.

**Exceptions (Postgres-only features):**
- `vector` column type (pgvector) — in SQLite, replaced by the sqlite-vec virtual table
- Enum types (`pgEnum`) — in SQLite, `text` columns
- HNSW index (`CREATE INDEX USING hnsw`) — Postgres only; sqlite-vec uses brute-force scan by default

**Connection:** `postgres-js` with `prepare: false` (required for Supabase Supavisor transaction pooler). Pool size: 5 per service instance.

**Redis (Upstash, team mode only):**
- BullMQ queues: `record-run-event`, `assemble-context-pack`, `embed-context-pack`, `build-pack-graph`
- Session bridge: `session:{sessionId}:run_id` (24h TTL)
- Policy rule cache: `policy:project:{projectId}:rules` (60s TTL)
- Feature pack cache: `pack:{projectId}:{slug}:{version}` (300s TTL)

Upstash is serverless Redis — no instance to manage, no Sentinel configuration, no capacity planning. At 1–10 devs, cost is negligible.

### 4.3 Schema Design Principles

**Append-only tables** (no UPDATE, no DELETE):
- `run_events` — immutable tool-use traces
- `policy_decisions` — immutable audit log
- `context_packs` — immutable session records

These are historical facts. Mutability creates data loss risk. If a record needs "correction," a new record is inserted and the old one is superseded — never deleted.

**Idempotency keys on every write:**
```
runs              → run:{projectId}:{sessionId}:{uuid}
run_events        → {sessionId}-{toolUseId}-{phase}
policy_decisions  → pd:{sessionId}:{toolUseId}:{toolName}:{eventType}
context_packs     → one per runId (existence check before insert)
knowledge_edges   → unique(projectId, sourceType, sourceId, targetType, targetId, edgeType)
```

> **F14 closure (2026-04-27 verification).** The original
> `policy_decisions` formula was `pd:{sessionId}:{toolName}:{eventType}`,
> which collapsed legitimately distinct tool invocations within a
> session — e.g., Write to file A (deny) and Write to file B (allow)
> shared the key, the second row dropped on the UNIQUE index, and the
> audit trail lost the second decision. SOC2 / NHI governance depends
> on every decision having a row, so `toolUseId` is now part of the key.
> Retry dedupe (same toolUseId on the same tool/event in the same
> session) still collapses to one row. Legacy callers that omit
> toolUseId fall back to the `'no-turn'` sentinel; both
> `apps/hooks-bridge` (Claude Code / Cursor / Windsurf turn ids) and
> `apps/mcp-server::check_policy` (optional `toolUseId` input field)
> now thread the value through.

**Index strategy (Postgres team mode):**
```sql
CREATE INDEX run_events_run_created_idx    ON run_events (run_id, created_at);
CREATE INDEX context_packs_proj_created_idx ON context_packs (project_id, created_at DESC);
CREATE INDEX policy_rules_proj_priority_idx ON policy_rules (policy_id, priority ASC);

-- HNSW for semantic search (Postgres only)
CREATE INDEX context_packs_embedding_hnsw ON context_packs
  USING hnsw (summary_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

**No table partitioning.** Partitioning earns its place at >100M rows. At 1–10 devs over 1 year, you reach ~500K events at most. Index-only scans handle this comfortably for years.

---

## 5. CAP Theorem — Per-Service Analysis

CAP is a per-boundary decision, not a system-wide one.

### Policy Evaluation (PreToolUse) → AP

Agent blocking is the highest-stakes path. Being unavailable (blocks agents) is worse than being inconsistent (60-second stale rules).

- Cache miss → DB query. DB down → default allow.
- Stale policy rules for up to 60 seconds: acceptable. No security attack is feasible in a 60-second stale window in a coding assistant governance system.
- On any failure → return allow. No exceptions.

### Run Event Recording (PostToolUse) → Eventual Consistency

Agent must not wait for DB writes. Outbox pattern:
- Return HTTP response before any DB write.
- Event goes to queue (SQLite in solo, Redis in team).
- Worker drains to DB asynchronously.
- At-least-once delivery + idempotency keys = exactly-once record.
- Acceptable lag: up to 5 seconds from event to DB persistence.

What you sacrifice: if the machine crashes between HTTP response and queue write, that event is lost. At 1–10 devs, this is rare and acceptable.

### Feature Pack Retrieval (MCP) → AP, Cache-First

Read-only, called once per session. Cache → DB on miss → stale cache on DB failure.
- Redis cache (300s TTL). On Redis + DB failure: return the last cached version or a structured error.
- Stale packs (up to 5 min): acceptable. Tech leads don't push pack changes mid-session.

### Context Pack Semantic Search → AP, High Latency Tolerance

Search is advisory, not transactional. Stale or missing results: agent proceeds without the extra context. On NL Assembly failure: return empty results with a warning.

### Session State (Redis Bridge) → AP

If Redis is down at SessionStart: create run record, skip Redis write.
If Redis is down at PreToolUse: cannot find runId → allow, log. Event correlation lost for that session — the audit trail degrades, the agent does not.

### Cloud Sync → Eventual Consistency

Local SQLite is the source of truth while offline. Cloud receives records eventually. Conflict policy: last-write-wins per record (safe because all records are append-only — there is no update conflict).

---

## 6. Availability, SLA, SLO

### Solo Mode

No SLA, no SLO. Availability = developer's machine uptime. MTTR = seconds (restart the daemon).

Local latency targets (soft, not monitored):
- `POST /hooks/pre-tool-use`: p95 < 50ms (in-memory eval, local SQLite)
- `MCP get_feature_pack`: p95 < 20ms (local SQLite)
- Web app page loads: p95 < 200ms (local Next.js)

### Team Cloud Mode

**The only SLO that materially affects users: `POST /hooks/pre-tool-use` p95 < 150ms, error rate < 1%.**

This is the only endpoint that blocks agent tool execution. All other endpoints affect UX but not agent blocking.

Latency budget breakdown (cloud):
- Local adapter script: ~20ms
- Network RTT agent → cloud: ~10–30ms (same continent, single region)
- Redis policy cache hit: ~3ms
- In-memory eval: ~0.5ms
- BullMQ enqueue (async, overlaps response): ~5ms
- **Total: well under 150ms p95**

**Web app SSR pages:** p95 < 800ms target. A read replica is not provisioned by default — when observed p95 measurably degrades, add a Supabase read replica and route list/detail queries (runs, context packs, events) through it. See §15.

**Context pack assembly:** best-effort, target < 30s end-to-end. Fully async, no SLO.

**Cloud availability target: 99.5%** (43.8 hours downtime/year). Achieved via:
- 2 stateless instances of each service
- Supabase-managed Postgres HA (automatic failover)
- Upstash Redis (serverless, managed HA)

---

## 7. Fault Tolerance

### Fail-Open Principle (Non-Negotiable, Carried Forward)

Every handler returns `allow` or `continue: true` on every error path. This is the most important single design principle in the system.

- Zod parse failure → allow
- Redis down → allow
- DB query fails → allow
- Policy eval times out → allow
- Session not found → allow

The only intentional block is an explicit policy `deny`. Everything else defaults to allow.

### Circuit Breakers (Team Cloud Mode)

Use `cockatiel` (TypeScript):
```typescript
const redisBreaker = new CircuitBreakerPolicy({
  halfOpenAfter: 30_000,        // 30s recovery probe
  breaker: new ConsecutiveBreaker(5),  // open after 5 consecutive failures
});
// Separate breaker per external dependency: Redis, DB, Anthropic, Ollama
```

When open: return allow immediately without calling the dependency. The open state IS the fallback.

### Context Pack Assembly: Three-Tier Degradation

```
Tier 1 (always): load events → build basic content → INSERT context_pack
Tier 2 (if Semantic Diff reachable): /analyze → add API diff, new modules, test changes
Tier 3 (if LLM available): /enrich → add narrative summary, breaking changes, key decisions
```

Tier 3 failure → Tier 2 data survives. Tier 2 failure → Tier 1 data survives. Context pack is always saved. No tier failure cascades downward.

### Worker Queue Retry Policy

Solo (SQLite queue): 3 attempts, exponential backoff (1s → 5s → 30s). After 3 failures: `status = 'failed'`. Failed jobs are logged. Other jobs are not blocked.

Team (BullMQ): Same retry policy. After 3 failures: job moves to named dead-letter queue (`${name}-dead`). Dead-letter queue is visible in the web app's admin panel.

### Sync Daemon Resilience

On network error: exponential backoff (30s → 60s → 120s, capped).
Data is never dropped: unsynced records remain in SQLite with `synced_at IS NULL`.
On recovery: resumes from all unsynced records. Cloud API deduplicates via idempotency keys — re-sending the same batch is safe.

---

## 8. Throughput and Latency

### Solo Mode: Latency Only

At 1 developer with 1 active agent session, the hooks bridge receives ~3–4 req/sec during intensive use (100 tool calls/hour × 2 hooks each / 3600s ≈ 0.06 req/sec average, ~1 req/sec burst). SQLite handles thousands of reads/writes per second on a modern laptop. No throughput concern exists.

The only latency concern: `PreToolUse` must return before the agent times out. Target: p95 < 50ms local. Achieved by: SQLite indexed read (~1ms), in-memory glob eval (~0.1ms). The bottleneck is local I/O, which is well within budget.

### Team Cloud Mode: Realistic Numbers at 10 Developers

Peak hook call rate: 10 devs × 100 tool uses/hour × 2 hooks / 3600s ≈ **0.56 req/sec**.

A single Hono process handles 5,000+ req/sec. Two instances run for availability, not capacity. BullMQ processes 100+ jobs/sec. Postgres handles thousands of inserts/sec. The cloud tier is never the bottleneck at this scale.

All throughput optimization work should be deferred until there are measurable latency regressions.

---

## 9. Networking and Transport Layer

### Solo Mode: Loopback Only

All services bind to `127.0.0.1`, not `0.0.0.0`. No external exposure. No TLS (loopback traffic never traverses a network). No reverse proxy. No load balancer. No CDN.

```
Claude Code   → 127.0.0.1:3101  (Hooks Bridge)
Windsurf hook → 127.0.0.1:3101  (Hooks Bridge, via adapter script)
Windsurf MCP  → 127.0.0.1:3100  (MCP Server, HTTP)
Claude MCP    → stdio            (no network at all)
Browser       → 127.0.0.1:3000  (Web App)
Hooks Bridge  → 127.0.0.1:3201  (Semantic Diff, internal call)
Hooks Bridge  → 127.0.0.1:3200  (NL Assembly, internal call)
```

**Why no CDN in solo mode:** There are no static assets being served to distributed users. The web app is a local Next.js process. A CDN would add zero value.

**Why no TLS on loopback:** TLS protects data in transit over untrusted networks. The loopback interface never leaves the machine. Adding TLS here provides no security benefit and adds certificate management overhead for zero gain.

**Why no load balancer:** Single user, single machine. Nothing to balance.

### Team Cloud Mode: HTTPS, No CDN

Services exposed publicly:
- `https://hooks.coodra.dev` → Hooks Bridge
- `https://mcp.coodra.dev` → MCP Server (remote MCP, optional)
- `https://app.coodra.dev` → Web App

TLS terminated at the platform load balancer (Railway/Fly.io, Let's Encrypt, managed). No certificate management needed.

**Why no CDN in team mode either:**
- The web app serves authenticated, user-specific pages. CDN caching of authenticated content creates security risks.
- Static assets (JS bundles, CSS) are content-hashed by Next.js and cached by the browser — this is sufficient without a CDN.
- CDN earns its place when serving static assets to millions of geographically distributed users who need reduced latency. 10 developers on a private team tool do not need this.

**The correct solution if latency from remote developers is measurable:** Deploy the Hooks Bridge to an additional cloud region closer to those developers (Fly.io regional instances). This is compute-at-edge, not content distribution. Invoke only if `PreToolUse` p95 measurably exceeds the 150ms target.

### Keep-Alive Connections

The Windsurf adapter script uses `curl --keepalive-time 60` to reuse the TCP connection across multiple hook calls within the same session. Hono + Node.js HTTP keep-alive is enabled by default. This eliminates TCP setup overhead for repeated hook calls.

### HTTP Version

Solo: HTTP/1.1. Sequential tool calls from one agent on loopback don't benefit from multiplexing.

Team cloud: HTTP/2 where supported (Railway/Fly.io TLS terminator enables it). HTTP/2 header compression is a free benefit at no code cost.

---

## 10. API Design, Versioning, and Backward Compatibility

### URL Structure

All external APIs versioned at path:
```
POST /v1/hooks/session-start
POST /v1/hooks/pre-tool-use
POST /v1/hooks/post-tool-use
POST /v1/hooks/session-end
POST /v1/hooks/windsurf        ← Windsurf normalized ingress
GET  /v1/health
POST /api/sync                 ← Cloud sync, internal
POST /api/graphify/analyze     ← Graphify graph upload
POST /api/graphify/import      ← Graphify feature pack import

# Issue tracker integration (see §22) — Direct (ADR-016): Jira is the wired Atlassian Rovo MCP.
# Coodra exposes NO Jira HTTP routes: no OAuth start/callback, no disconnect, no webhook ingress.
# `coodra jira enable` writes Rovo's remote-MCP entry into the agent config; OAuth is Rovo's own (IDE /mcp flow).

# GitHub governance & context layer (see §23)
GET  /api/integrations/github/install/start         ← redirect to GitHub App install page
GET  /api/integrations/github/install/callback      ← post-install handler, mints first token
POST /api/integrations/github/:integrationId/refresh ← manual repo graph index re-sync
DELETE /api/integrations/github/:integrationId      ← local teardown (GitHub-side removal is done in github.com UI)
POST /v1/webhooks/github                            ← inbound GitHub App webhook (X-Hub-Signature-256)
```

MCP tools versioned implicitly through MCP protocol capability negotiation. Tool names are stable identifiers for the lifetime of the major version.

**Why path versioning, not subdomain:** `v1.api.coodra.dev` requires DNS changes per version. `/v1/...` is a routing change. Path versioning is operationally simpler.

### Hook Payload Versioning

Include `schema_version` in all hook payloads:
```json
{ "schema_version": "1.0", "hook_event_name": "PreToolUse", ... }
```

The Hooks Bridge reads this field and routes to the correct adapter. When an agent changes its schema, a new adapter version coexists with the old one. Both are served until v1.0 is deprecated.

### Backward Compatibility Rules

Non-negotiable:
1. Never remove a field from a response.
2. Never change a field's type.
3. Never add a required field to a request body (new fields must be optional with defaults).
4. Enum additions are non-breaking. Enum removals require a major version bump.

### Sunset Policy

`v1` lives for 6 months minimum after `v2` ships. Deprecation signaled via response headers:
```
Deprecation: true
Sunset: Sat, 01 Jan 2027 00:00:00 GMT
```

Hook adapter scripts log a deprecation warning on each response during the sunset window.

### MCP Tool Stability

MCP tool names are permanent for the major version lifecycle. Input schema: additive only. Output schema: additive only. A removed tool keeps its name as an alias for one major version before being dropped.

---

## 11. CORS Configuration

### Solo Mode

No CORS headers needed — but for the right reason. The browser's same-origin policy is based on **scheme + host + port**: `http://localhost:3000` and `http://localhost:3101` are different origins and would require CORS if the browser called port 3101 directly.

The reason no CORS configuration is needed in solo mode is that **the browser never calls the Hooks Bridge or MCP Server directly**. The browser only calls the Next.js web app on port 3000. When the web app needs to query local services (Hooks Bridge, MCP, Semantic Diff), it does so from server-side Node.js code (`fetch()` in a Next.js Route Handler or Server Action). Server-to-server calls on the same machine are not subject to browser CORS policy — CORS is enforced by the browser, not by the server.

If you ever add a browser-side `fetch` that directly calls port 3101 or 3100, CORS headers **will** be required on those services. Design client-side calls to always go through the Next.js layer to avoid this.

### Team Cloud Mode (Web App Only)

```typescript
const ALLOWED_ORIGINS = [
  'https://app.coodra.dev',
  ...(process.env.NODE_ENV === 'development' ? ['http://localhost:3000'] : []),
];

// On each response:
const origin = request.headers.get('Origin');
if (origin && ALLOWED_ORIGINS.includes(origin)) {
  response.headers.set('Access-Control-Allow-Origin', origin);
  response.headers.set('Access-Control-Allow-Credentials', 'true');
  response.headers.set('Access-Control-Max-Age', '86400');  // 24h preflight cache
}
// Rejected origins get no CORS headers (browser blocks the request)
```

**Never `Access-Control-Allow-Origin: *` with credentials.** Browsers reject this combination per spec. It would also allow any site to make credentialed requests to the API.

**Hooks Bridge and MCP Server (both modes):** No CORS headers. These endpoints receive requests from agent processes or server-side Next.js code, never from browser `fetch` directly. Agent processes and server-side Node.js are not subject to browser CORS policy. If this ever changes (e.g., a future in-browser extension calls these ports directly), add CORS headers at that point.

---

## 12. Caching — All Three Layers

### Browser Cache

Next.js content-hashes all static assets at build time:
- `/_next/static/**`: `Cache-Control: public, max-age=31536000, immutable` — permanent, safe because filename changes on content change
- HTML pages: `Cache-Control: no-cache, no-store` — always revalidate
- Authenticated API responses: `Cache-Control: no-store`

No CDN cache layer. The browser's own cache is sufficient.

### Application Cache

| Key pattern | Value | TTL | Eviction |
|---|---|---|---|
| `session:{sessionId}:run_id` | run UUID | 24h | TTL |
| `policy:project:{projectId}:rules` | JSON rules array | 60s | TTL |
| `pack:{projectId}:{slug}:{version}` | resolved pack JSON | 300s | TTL + version bump |

Solo mode: these are stored in an in-process `Map<string, { value: string; expiresAt: number }>`. Same TTL semantics. Cold on process restart (first request fetches from SQLite — still fast).

**What is NOT cached:** Policy decisions (context-specific per tool + path + agent), individual run events, context pack content queried on demand.

### Database Cache

Postgres `shared_buffers` (25% RAM on Supabase) automatically caches hot pages: policy rules table (small, frequently read → always hot), feature packs (small-to-medium → hot after first session start), run_events (large, random access → partial benefit).

No query-level caching layer. The DB buffer cache is sufficient at this scale.

---

## 13. Server Setup and Infrastructure

### Solo Mode: `coodra start`

```bash
$ coodra start
→ Ensures SQLite DB exists at ~/.coodra/data.db
→ Starts MCP Server (stdio handler + HTTP :3100)
→ Starts Hooks Bridge (HTTP :3101 + in-process workers)
→ Starts Web App (Next.js :3000)
→ Starts Semantic Diff (:3201, Python)
→ Starts NL Assembly (:3200, Python, optional — skips if Ollama absent)
→ Writes hook scripts to ~/.claude/settings.json + ~/.windsurf/hooks/coodra.sh
→ Writes MCP configs to ~/.mcp.json + ~/.windsurf/mcp_config.json
→ Prints: "Coodra running at http://localhost:3000"
```

Process management: PIDs written to `~/.coodra/pids`. `coodra stop` kills them. No Docker, no Compose, no daemon manager needed for solo mode.

### Team Cloud Mode: Two Deployment Groups

**API cluster** (stateless, 2 instances each):
- Hooks Bridge
- MCP Server
- Web App (Next.js)

**Worker cluster** (background, 1–2 instances each):
- Event Worker (drains `record-run-event`)
- Pack Assembler (drains `assemble-context-pack`)
- Embedding Worker (drains `embed-context-pack`)

Deployment target: **Railway or Fly.io**, single region. Managed TLS, managed load balancing, Docker-based deploys. Not AWS/GCP — the operational overhead of cloud-native infra is unjustified at 1–10 devs.

**Health checks:** Every service exposes `GET /health` → `{ status: "ok", uptime: N }` in under 5ms. No DB calls in the health check. A slow DB does not cause the load balancer to remove a healthy instance.

### Process Architecture (Hooks Bridge)

```
Hooks Bridge (Hono, port 3101)
  ├── POST /v1/hooks/session-start     → sessionStartHandler
  ├── POST /v1/hooks/pre-tool-use      → preToolUseHandler
  ├── POST /v1/hooks/post-tool-use     → postToolUseHandler
  ├── POST /v1/hooks/session-end       → sessionEndHandler
  ├── POST /v1/hooks/windsurf          → windsurfAdapter → routes above
  ├── GET  /v1/health
  ├── Worker: recordRunEventProcessor  (SQLite queue | BullMQ)
  └── Worker: assembleContextPackProcessor (SQLite queue | BullMQ)
```

Workers run in the same process in solo mode (separate async loops). In team mode, workers are separate deployments consuming BullMQ from Upstash Redis. The processor function signatures are identical.

---

## 14. Database Selection Rationale

### SQLite for Solo

| Criterion | SQLite | Local Postgres |
|---|---|---|
| Setup | zero — file on disk | requires Docker or homebrew install |
| WAL concurrency | readers + 1 writer, concurrent | full MVCC |
| Scale at 1–10 devs | more than sufficient | overkill |
| Portability | copy one file | dump/restore |
| Vector search | `sqlite-vec (brute-force KNN + optional ANN)` | `pgvector (HNSW)` |
| Cold start | < 1ms (file open) | ~20ms (connection + auth) |

SQLite WAL concurrency is sufficient: one writer (Hooks Bridge), multiple readers (MCP, Web App). They coexist without blocking each other. The single-writer constraint is not a limitation at 1–10 devs on one machine.

### Postgres for Team

- Schema is relational: projects → packs → runs → events. Joins are the primary query pattern.
- pgvector is a native Postgres extension. No separate vector DB to operate.
- Drizzle ORM supports Postgres directly with the same query syntax as SQLite mode.
- Supabase manages HA, backups, Supavisor pooler, and migrations UI.

### Why NOT a Separate Vector Database

Pinecone, Weaviate, Qdrant: each introduces a new service to deploy, a new connection to manage, a new failure mode, and a data synchronization problem (keeping Postgres and the vector DB in sync). The threshold for justifying this complexity is when pgvector query times measurably degrade user experience at scale. At 22 packs (current) or even 22,000 packs, pgvector HNSW returns results in <50ms p99.

### Why Redis Only in Team Mode

In team mode, multiple service instances on different machines must share queue state. SQLite is single-file, single-machine. Redis is the correct distributed queue backend for BullMQ.

In solo mode (single process, single machine), in-process SQLite queue eliminates Redis as an operational dependency entirely.

---

## 15. Scaling Strategy

### Solo Mode

Not a scaling problem. One developer, one machine. Design for correctness.

### Team Cloud Mode

**API services:** Stateless. Scale by adding instances. No sticky sessions, no shared process state. Redis and Postgres are the only shared state. Scale signal: CPU > 70% sustained or response times rising.

**BullMQ workers:** Scale by adding worker processes. Each is an independent consumer. Scale signal: `waiting` queue depth > 100 jobs. Each worker handles 100+ simple DB-write jobs per second.

**Postgres:** Single writer (Supabase-managed). The async write path smooths write spikes naturally. Add a read replica when web app read query latency degrades measurably. No sharding needed below ~1000 active developers.

**Redis:** Upstash serverless scales automatically. No capacity planning.

**Semantic Diff:** CPU-bound (tree-sitter AST parsing). Scale by adding instances behind a simple HTTP load balancer. In solo mode, single instance is always sufficient.

**When you outgrow this architecture:** The service boundaries are already clean and coupling is minimal. Each service can be extracted and independently scaled. Reaching these limits means thousands of active developers and the revenue to support proper infrastructure investment.

---

## 16. Design Patterns

### Carried Forward (All Proven in Prototype)

1. **CQRS** — Hooks Bridge = write. MCP Server = read. No coupling between them.
2. **Event sourcing** — `run_events` is the immutable fact log. Context packs are derived views.
3. **Outbox pattern** — Queue as outbox. Worker drains to DB. Response returned before DB write.
4. **Fail-open** — Every error path returns allow/continue.
5. **Dependency injection at construction** — Handlers are factories. Tests inject mocks.
6. **Zod at every external boundary** — Invalid payloads fail-open. Shared schemas in `@coodra/shared`.
7. **Schema as canonical type source** — Drizzle schema → Drizzle types. Zod schemas → TS types.
8. **Polymorphic knowledge graph** — `knowledge_edges` table: (sourceType, sourceId) → (targetType, targetId).
9. **Feature pack inheritance** — Scalar override + array concatenation, root → leaf, with cycle detection.
10. **Three-tier graceful degradation** — Context pack assembly never fails completely.
11. **Structured pino logging** — Correlation IDs (sessionId, runId, orgId) on every log line.

### New in v2

**12. Per-agent adapter at hook ingress:**
One adapter function per agent normalizes the raw payload to `HookEvent`. Zero agent-specific code downstream of the adapter layer. Adding a new agent = one new adapter function + one new shell script.

**13. Storage adapter pattern:**
```typescript
interface StorageAdapter {
  db(): Db;           // Drizzle instance (sqlite | postgres)
  queue(): IQueue;    // SQLiteQueue | BullMQQueue
  cache(): ICache;    // InProcessCache | RedisCache
}
```
`LocalStorageAdapter` for solo. `CloudStorageAdapter` for team. Services receive via DI. No `if (mode === 'solo')` in business logic.

**14. CLI subprocess orchestration:**
The Coodra CLI can invoke external tools (Graphify, Ollama, git) as subprocesses and pipe their output to local API endpoints. This is how Graphify integration works without requiring the developer to manually handle files.

**15. Rate limiting (team mode only):**
Redis sliding window per org. Lua script: atomic `ZREMRANGEBYSCORE` + `ZADD` + `ZCARD`. Prevents one org's runaway agent from flooding the cloud API. Not needed in solo mode.

**16. Outbound integration pattern (GitHub and future Build-style connectors):**
This pattern applies to integrations Coodra calls *itself* — GitHub (§23) and any future connector where no vendor MCP exists. Each makes its third-party calls through a per-integration `IntegrationClient`: pull credentials from `integration_tokens`, wrap every call in a per-org `cockatiel` circuit breaker + 10s timeout, record a row in `integration_events` (idempotency key = `{integrationId}:{operation}:{externalRef}`), return a typed `Result<T, IntegrationError>`. Tool handlers never throw when the third-party is unreachable — they return a structured "degraded" response so the agent keeps moving. Token refresh and retry are the client's job, not the caller's. **Jira does NOT use this pattern** — it is consumed Direct (ADR-016): Coodra wires Atlassian's Rovo MCP and the agent calls it, so there is no Coodra-side Jira `IntegrationClient`, no `integration_tokens` / `integration_events` for Jira. Prefer the Direct pattern whenever the vendor ships a maintained MCP.

**17. Inbound webhook pattern:**
Third-party webhooks land on `POST /v1/webhooks/<provider>` in team mode. Each handler: (a) verifies HMAC/signature using the per-integration secret, (b) returns 200 OK within 5s (fail-open on signature-match edge cases is NOT permitted — signature mismatch must return 401), (c) enqueues a `<provider>-webhook-event` job carrying the raw body + extracted entity IDs, and (d) lets the worker update local state idempotently. See §23.8 (GitHub). **Jira has no inbound webhook** — it is consumed Direct and Rovo is pull-only (ADR-016).

**18. Repository Graph Index (policy-input materialization):**
When a third-party config document is read on the agent's hot path (e.g., CODEOWNERS on every `pre_tool_use`), it must be materialized into a first-class local table and refreshed via webhooks, not fetched live. The pattern is: parse on ingest → store as structured rows → hydrate the policy engine / NL assembly from the local table → refresh via targeted webhook events → nightly drift-reconciliation cron. Applies to CODEOWNERS and branch protection today (§23.4); will apply to Linear workflow states and equivalents in the future. Rule of thumb: *if it's read by the 150 ms hot path, materialize it locally.*

**19. Tool descriptions are agent prompts, not docstrings:**
Every MCP tool exposed by the server is, at runtime, a standing line in the agent's system prompt. The `description` field is not documentation — it is the call-site instruction the agent's planner consults to decide whether to invoke the tool. Every description starts with an imperative trigger phrase (*"Call this BEFORE..."*, *"Call this when the user asks..."*), states the return shape, and names the consequence of skipping it. Descriptions are colocated with handlers in `manifest.ts` and tested mechanically (trigger-phrase presence, length budget, snapshot diff) on every push. This pattern is the bridge between the architecture (what tools exist) and the agent's actual behaviour (whether they get called). See §24 for the full contract.

**20. Bridge-mediated autonomous coordination defaults (added 2026-05-02, decision `dec_83ba10c1`):**
The two coordination acts that must happen on every session — Feature Pack injection at session start, and Context Pack save at session end — fire from the **hooks-bridge** by default, not from the agent's MCP tool calls. Pattern 19 (tool descriptions as agent prompts) makes the surface *callable*; this pattern makes the defaults *firing without agent cooperation*.

Mechanics:
- **SessionStart hook** → bridge resolves the project's Feature Pack via the same `featurePack` store the MCP server uses, then returns `{ permissionDecision: 'allow', additionalContext: <pack body> }`. Claude Code's hook spec injects `additionalContext` directly into the agent's turn-zero context. Result: a stranger who runs `npx @coodra/cli init` and restarts Claude Code gets the Feature Pack on turn zero with zero agent action.
- **SessionEnd / Stop hook** → bridge generates a structured summary from `run_events` + decisions for the closing run, then calls `contextPack.save(...)` against the same store the MCP `save_context_pack` tool uses. The hook responds `allow` synchronously; the save runs through the durable outbox (Pattern 3). Result: every session produces a Context Pack, even when the agent forgets to ask.

Why this lives in the bridge, not in the agent:
- The agent-driven path (CLAUDE.md trigger contract + §24 manifest) is a *convention layer* — it nudges, doesn't enforce. Verified empirically (2026-05-02 Phase 1 audit): agents under token pressure skip the calls, and agents that don't load CLAUDE.md (raw API, future non-Claude clients firing only the hook events) never see the convention at all.
- The bridge-side path is *protocol*. It fires whenever the hook fires. No agent cooperation required.

The MCP tools `get_feature_pack` and `save_context_pack` remain in the §24 manifest. They are now **on-demand surfaces** — the agent calls them mid-session when switching modules (refresh the pack against a new `filePath`) or when the user explicitly asks "save the context pack now". The autonomous default is the bridge's job; the manual override is the tool's job.

Solo-mode v1 scope: this pattern fires only for Claude Code's hook envelope (which has a first-class `additionalContext` field). Cursor and Windsurf use stdin/stdout adapters that don't surface a context-injection slot the same way; they continue to rely on Pattern 19 + the agent's trigger contract. Wider agent coverage tracked as a follow-up.

---

## 17. Graphify Integration — Full Flow

> **Rewritten 2026-05-21 (Module 09, Option C).** The previous §17 described a
> Coodra-owned `graph.json` reader, two `/api/graphify/*` web endpoints, a
> `graphify_graphs` table, and `knowledge_edges` — none of which were ever
> built; their assumptions were stale. The Option-C design below is implemented
> by Module 09 (`docs/feature-packs/09-integrations/`); see also
> `essentialsforclaude/11-adrs.md` ADR-010 (rewritten).

### What Graphify Is

Graphify (`safishamsi/graphify`, MIT, PyPI package `graphifyy`) is a mature,
actively-developed codebase-knowledge-graph tool — tree-sitter AST extraction
across 30+ languages plus SQL, docs, and PDFs, with Leiden community detection.
It is **not built by Coodra**. Running it (`graphify .`, or the `/graphify`
skill inside an AI assistant) produces a `graphify-out/` directory in the repo:
`graph.json` (the full graph, NetworkX node-link format — every node carries a
`community` integer), `GRAPH_REPORT.md`, and `graph.html`. Crucially, Graphify
also ships **its own MCP stdio server** — `python -m graphify.serve
graphify-out/graph.json` — exposing `query_graph`, `get_node`, `get_neighbors`,
and `shortest_path`.

### How Coodra Consumes Graphify — Option C

Coodra wires Graphify's **own MCP server** into the agent's MCP config, next to
the `coodra` server. The agent queries Graphify directly for structural
questions — blast radius before a refactor, "where is X defined?", dependency
paths. Coodra builds **no** `graph.json` reader, **no** producer, **no** parser.
This is the same "wire the external MCP server, don't rebuild it" pattern Coodra
uses for the Jira integration (§22), and the Pattern-20 thesis applied to
structural context: ship the integration as wiring + recipes, not as a service.

### Coodra's Leverage — Graphify as the Query Layer (ADR-015, 2026-05-23)

> **Superseded approach.** This section originally described a
> `coodra__seed_feature_packs_from_graph` tool that minted one draft Feature
> Pack per Leiden community, plus a `structure` block on `get_feature_pack`.
> Both were **retired in ADR-015**. On a real 9,659-node repo Graphify produced
> 588 communities, 73.5% of them single-file (config files, READMEs); seeding
> them created hundreds of un-injectable shells, and `get_feature_pack`'s
> `filePath` resolution (the only path that could surface them) was never
> implemented. A code-graph community is a navigation aid, not a Feature Pack
> boundary.

Coodra's leverage of Graphify is its **live structural-query layer**, consumed
through Graphify's own MCP server (`query_graph` / `get_node` / `get_neighbors`
/ `shortest_path`), wired alongside the `coodra` server via `coodra graphify
enable`. The agent calls those tools directly for blast-radius and "where is X
defined?" questions. Coodra mints **no** Feature Packs from the graph; Feature
Packs stay human/agent-authored at module granularity. If agent-assisted
cold-start authoring is revisited, ADR-015 records its two preconditions:
module granularity (not communities) and working `filePath`→`sourceFiles`
resolution.

### What Is Retired

The `query_codebase_graph` MCP tool and `apps/mcp-server/src/lib/graphify.ts`
read `~/.coodra/graphify/<slug>/graph.json` — a path nothing ever writes
(Graphify writes `<repo>/graphify-out/graph.json`) — so the tool was permanently
in a `codebase_graph_not_indexed` soft-failure. Module 09 (track 9B, phase G1)
removes both. Structural queries are answered by Graphify's own MCP server.

### Cross-References

- `essentialsforclaude/11-adrs.md` — ADR-010 (rewritten).
- `docs/feature-packs/09-integrations/` — Module 09 spec, implementation plan, techstack.
- §22 — the Jira integration, the sibling external-MCP integration under Module 09.

---

## 18. LLM Enrichment Strategy

### Two-Tier Provider Model (amended 2026-04-24 — Gemini is the managed path; Anthropic deprecated)

```
Tier 1 — Local (solo default, no API key needed):
  Ollama running on developer's machine
  Model: llama3.1:8b (recommended) or mistral:7b-instruct
  Purpose: structured JSON extraction for context pack summaries

Tier 2 — Managed cloud (team-mode default, our key):
  GEMINI_API_KEY → gemini-1.5-flash
  Used by the team-mode hosted NL Assembly service with the org-owned key.

Anthropic Claude was the previous Tier-2 default and is no longer the
documented path. The env var slot may stay as an undocumented advanced
override but is not recommended. See decisions-log 2026-04-24 — "Managed
LLM in team mode is Gemini, not Anthropic."
```

### Runtime Provider Selection

```python
def _select_provider(self) -> Optional[LLMProvider]:
    if os.getenv("GEMINI_API_KEY"):
        return GeminiProvider()              # team-mode managed path
    if self._ollama_available():
        return OllamaProvider(model="llama3.1:8b")  # solo default
    return None  # enrichment skipped, AST-only mode

def _ollama_available(self) -> bool:
    try:
        r = requests.get("http://localhost:11434/api/tags", timeout=2)
        return r.ok and any(m["name"].startswith("llama3") 
                           for m in r.json().get("models", []))
    except: return False
```

### Ollama Structured Output

Ollama's JSON mode (`format: "json"`) with low temperature for reliable extraction:
```python
# Define schema once (mirrors the Zod schema in TypeScript via zod-to-json-schema)
ENRICHMENT_SCHEMA = {
  "type": "object",
  "properties": {
    "summary":          { "type": "string" },
    "breaking_changes": { "type": "array", "items": { "type": "string" } },
    "key_decisions":    { "type": "array", "items": { "type": "string" } },
    "risk_level":       { "type": "string", "enum": ["low", "medium", "high"] }
  },
  "required": ["summary", "breaking_changes", "key_decisions", "risk_level"]
}

response = ollama.chat(
    model='llama3.1:8b',
    format=ENRICHMENT_SCHEMA,     # JSON Schema object, not bare 'json' string
    options={'temperature': 0.1},
    messages=[{ 'role': 'user', 'content': ENRICHMENT_PROMPT.format(diff=diff[:4000]) }]
)
```

The schema object form is more reliable than `format: 'json'` — Ollama constrains the output to the schema shape rather than just activating JSON mode. The 4,000-token truncation prevents exceeding Ollama's effective context window. AST diff data is always included in full (it's compact). The same schema should be defined as a Zod object in TypeScript and converted to JSON Schema via `zod-to-json-schema` for the Python service to consume — this keeps types in sync at the boundary.

### Degradation

No LLM available → `enrichment_status = "skipped"`. Context pack is saved with Tier 1 (run events) + Tier 2 (AST structural diff). This is a valid operating state, not an error condition. The pack is fully usable without LLM enrichment.

### Integration-Derived Enrichment Inputs

When the GitHub integration is active, the NL Assembly prompt receives additional context *before* the LLM call. This is how third-party coordination state enters the enriched context pack. See:

- **§23.9** — GitHub PR, review comments, CODEOWNERS hits, branch protection, and check-run statuses injected into the assembly prompt (per-run enrichment).

(**Jira enrichment is retired — ADR-016.** The Build design injected `currentIssue` + `openIssues` server-side into `get_feature_pack`; under Direct, the agent pulls live issue context itself via the wired Rovo MCP, so there is no server-side Jira enrichment of the assembly prompt.)

The GitHub enrichment follows a degradation contract: the fetch is subject to a 1 s budget, the field is silently omitted on timeout or failure, and the pack is still produced. The LLM sees presence or absence and emits a pack either way.

---

## 19. Auth Strategy

### Solo Mode: No Auth

All services accept requests without a token. Existing solo bypass (`CLERK_SECRET_KEY = 'sk_test_replace_me'`), unchanged. Org ID defaults to `org_dev_local`.

Not a security concern: solo mode services bind to `127.0.0.1`. External processes cannot reach them.

### Team Cloud Mode: Clerk JWT + Local Secret

Three-mode middleware:
1. `sk_test_replace_me` → bypass, dev org/user IDs
2. `Authorization: Bearer {LOCAL_HOOK_SECRET}` → **sync daemon → cloud-API authentication** (NOT bridge — see Module 04 Phase 4 Caveat 2 fix below)
3. Full Clerk JWT → production web app authentication

The `LOCAL_HOOK_SECRET` is generated on first `coodra team join` (Module 04 Phase 4; replaces the older `team login` plan) and stored in `~/.coodra/config.json::team.localHookSecret`. The sync daemon's cloud-push uses it as the bearer token when calling cloud Postgres-fronted REST endpoints.

#### Caveat 2 fix (Module 04 Phase 4, 2026-05-09): Hooks Bridge is local-only in both modes

The original architecture proposed a cloud-deployed Hooks Bridge that local agents (Windsurf, Cursor) would call directly via HTTPS with `LOCAL_HOOK_SECRET`. **That bridge does not ship.** Each developer's local Hooks Bridge is the protocol layer:
- Local audit events (run_events, decisions, policy_decisions, context_packs) write to local SQLite first.
- The sync daemon's outbox-worker pushes them to cloud Postgres asynchronously.
- The cloud web app reads cloud Postgres directly.

Why the change:
1. **Latency.** A cloud bridge added 50–200ms per hook event in the §6 hot path. Local-bridge + async-push has zero hot-path penalty.
2. **Failure mode.** Cloud bridge unreachable would either drop hook events or block agent sessions. Local-bridge + outbox is durable across cloud outages — events queue locally and drain on recovery.
3. **Auth surface.** A cloud bridge needed HTTPS, certs, DNS, and the bearer-token shape per request. The local bridge has none of those concerns.

The `LOCAL_HOOK_SECRET`'s scope narrows accordingly: it's now only consumed by the sync-daemon's cloud-API calls (push of pending_jobs, pull of decisions/context_packs/run_events), never by the bridge itself. The bridge still binds to `127.0.0.1:3101` exactly like solo mode.

#### Caveat 1 fix (Module 04 Phase 4, 2026-05-09): Bidirectional sync

Pre-fix: M04a's sync daemon was push-only (local → cloud). Post-fix: a `team-rows-puller` (apps/sync-daemon/src/lib/team-rows-puller.ts) ticks every 10s pulling cloud rows newer than the local watermark for `runs`, `decisions`, `context_packs`, and `run_events`. Without this, member A's decision was invisible to member B's local MCP server, breaking the M05 SessionStart recent-decisions injection.

ADR-007 append-only semantics make the pull conflict-free: `INSERT ... ON CONFLICT (id) DO NOTHING` for every row. No merge logic needed.

---

## 20. CI/CD Pipeline

### Solo Mode

No CI/CD. Developer runs `pnpm build && coodra start`. Local development.

### Team Cloud Mode

**Three stages:**

**Stage 1 — CI (every PR):**
1. `tsc --noEmit` across all packages (TypeScript strict, zero warnings)
2. `biome check` (lint, format — already in prototype)
3. `vitest run` — all 130 unit tests
4. Build all packages (`turbo build`)

Fail fast: TypeScript errors block everything. Zero tolerance on type errors.

**Stage 2 — Staging (merge to main):**
1. Build Docker images, push to registry
2. Deploy to staging environment
3. Smoke tests: SessionStart → PreToolUse → PostToolUse → SessionEnd → verify context pack assembled
4. Notify team

**Stage 3 — Production (manual trigger):**
1. Run `drizzle-kit migrate` against production DB (additive-only migrations, safe before code deploy)
2. Deploy new instances alongside old ones, route 10% of traffic
3. Watch error rate for 2 minutes
4. Route 100%, terminate old instances
5. Run smoke tests

**Migration safety rule:** Never drop a column in the same deploy as the code that stops using it. Drop it in the following deploy. All indexes created with `CONCURRENTLY` to avoid table locks on Postgres.

**Secrets:** All secrets are environment variables injected at deploy time. Zero secrets in the repo or Docker images. Rotated quarterly.

---

## 21. Open Decisions (Not Locked)

These are deliberate gaps — not omissions. Each requires new information before a decision is sound.

> **2026-04-24 amendment:** Two prior open decisions are now closed by user directive — see the "Resolved (kept here for traceability)" sub-table below. Two new constraints land at the same time: team mode is hosted by us (no BYO-cloud variant in v1), and the managed LLM is Gemini (not Anthropic). See `context_memory/decisions-log.md` 2026-04-24 entries.

### Resolved (kept here for traceability)

| Decision | Resolution (2026-04-24) |
|---|---|
| Hosted vs BYO-cloud team service | **Hosted by us only in v1.** Single managed Supabase Postgres + Upstash Redis + Railway/Fly.io stack. BYO-cloud is a post-launch Enterprise variant. Per user directive — "make the team service hosted by us." |
| Security: RLS and local secret permissions | **Closed in favor of single Postgres + RLS:** every team-scoped table carries `org_id`; Supabase Row-Level Security policies (`WHERE org_id = (auth.jwt()->>'org_id')::text`) enforce isolation at the DB layer. Local-mode secret-permission half stays open — `~/.coodra/config.json` MUST be `chmod 600` and the CLI (Module 08a) writes it with that mode. |
| Pricing / monetization | **Out of scope for v1.** No Stripe, no `subscriptions` / `usage_quotas` tables, no metering. Per user directive 2026-04-24 — "forget about monetary setup, only focus on building the working product." |
| Marketing / distribution site | **Out of scope.** No `coodra.dev` HTML or landing page in this repo. Module 08b removed. CLI is the only install surface in scope (Module 08a). |
| Solo-mode feature gating | **No gating.** Solo has full feature parity for everything technically possible without a hosted backend. Per user directive 2026-04-24 — "no restrictions." |

### Still open

| Decision | What to resolve first |
|---|---|
| Embedding model for vector search | Benchmark all-MiniLM-L6-v2 vs e5-small vs bge-small on context pack similarity quality |
| Sync conflict resolution for packs/rules | Last-write-wins is safe for append-only records (runs, events, decisions) but **not** for governance documents (feature packs, policy rules) that team members actively edit. Until a proper merge strategy (three-way merge, CRDTs, or field-level versioning) is designed, **treat cloud Postgres as the single writer for feature pack and policy rule mutations in team mode**. Local services read these documents from the Sync Daemon's pull path and treat them as read-only cache. This avoids conflict entirely at the cost of requiring connectivity to edit governance docs. |
| Graphify output format stability | Does Graphify's `graph.json` schema change across versions? Need versioning or a schema validation step in the adapter. |
| Windsurf `post_cascade_response` as session end proxy | This event fires after each Cascade response, not only at IDE close. Need to decide if each response is a session segment or if session end requires a different signal. |
| sqlite-vec upgrade path to team Postgres | When a solo user upgrades to team mode, local sqlite-vec embeddings must be migrated to pgvector. Recommended: re-embed from stored text (the source text is always persisted; re-running the embedding model is cheap). Direct float32 blob export is theoretically possible but requires matching model + normalization exactly. |
| MCP remote transport (future) | When remote MCP over HTTP becomes important for team setups, the MCP server needs HTTPS + Clerk auth on the `/mcp` endpoint. Design deferred until team mode reaches GA. |
| Sync table subset | Explicitly define which tables are synced local → cloud: `runs`, `run_events`, `context_packs`, `policy_decisions` (append-only, safe to replicate). Not synced: `feature_packs`, `policy_rules` (cloud is the single writer for these in team mode; local is a pull-only cache). If the sync scope expands, consider a change-data-capture (CDC) or logical-replication-driven approach instead of polling `WHERE synced_at IS NULL`. |
| Aggregated metrics / observability | The event log captures raw data but there is no plan for aggregated metrics (policy violation rates, enrichment failure rates, pack assembly latency distributions). Reserve a `usage_aggregates` table or a Prometheus `/metrics` endpoint now — even if unpopulated — so the slot exists when monitoring becomes important. |
| ~~JIRA OAuth encryption / state sync / multi-site / solo creds~~ | **SUPERSEDED by ADR-016 (Jira = Direct).** These were open decisions for the Build design: Coodra-stored OAuth token encryption, webhook-vs-poll reconciliation, multi-`cloudid` routing, and solo API-token storage. Under Direct, Coodra stores no Jira token, runs no webhook, and routes nothing — Atlassian's Rovo MCP owns all of it. None of these decisions remain open. |
| Issue-tracker scope expansion | Future trackers (Linear, Asana, GitHub Issues) follow the **Direct** pattern wherever the vendor ships a maintained MCP: wire it (`coodra <tracker> enable`) + a thin Run↔entity link, exactly like Jira (§22, ADR-016) and Graphify (§17, ADR-015). Build a Coodra-side client only where no vendor MCP exists — that path keeps the `IntegrationClient` + `integration_tokens` + `integration_events` scaffolding (GitHub §23 is the current Build example, richer — it adds CODEOWNERS + branch protection as first-class policy inputs, not just ticket reads). |
| GitHub App webhook secret rotation | The GitHub App webhook secret is App-level (not per-installation). Rotation requires updating the App's setting on github.com + the `GITHUB_WEBHOOK_SECRET` env var atomically. Runbook: generate a new secret, update the env var on all webhook-receiving instances, then update github.com. Old secret continues to verify for ~60 s during rollover (acceptable drift). |
| GitHub App private key storage | The App's RSA private key (PEM) is required to mint installation tokens. Store in a secrets manager (not an env var on disk). Key rotation: generate a second active key on github.com, deploy the new key, remove the first key. GitHub supports up to two active keys per App precisely for this flow. |
| CODEOWNERS re-parse on every push | Naive implementation re-parses on every `push` webhook. Optimization: only re-parse if `commits[].modified` includes `.github/CODEOWNERS` in its list. Bench this at 10–100 repos scale; if webhook processing latency creeps up, add a repo-level content hash check before parsing. |
| Branch protection API vs modern Rulesets | GitHub has two overlapping APIs: the older `/repos/{owner}/{repo}/branches/{branch}/protection` and the newer Rulesets API. The newer Rulesets API is preferred but requires the `administration: read` permission and is still being rolled out. The `branch_protection_rules.ruleset_id` column distinguishes the two. Fetch both and merge on the server side; the policy engine reads from the merged view. |

---

## 22. Issue Tracker (Jira / Atlassian) Integration — Direct (wire Atlassian's Rovo MCP)

> **SUPERSEDED-AND-REPLACED by ADR-016 (2026-05-31).** This section previously specified a "Build" connector — a `jira.js` REST client, a Coodra-owned OAuth 2.0 3LO app, hand-rolled ADF conversion, inbound webhooks, the `integration_tokens` / `integration_events` tables, and 8 `jira_*` MCP tools. That design is **retired**. Coodra now consumes Jira the same way it consumes Graphify (§17, ADR-010 / ADR-015): **wire the vendor's own MCP server and let the agent call it.** The Build mechanics live only in git history and in `External api and library reference.md` (marked superseded) as prototype reference. §22.9 lists exactly what was retired.

### 22.1 Goals and Non-Goals

**Goals.**
1. The agent reaches a session able to read the ticket it is working on — description, acceptance criteria, comments — without the developer pasting it into the prompt.
2. Coodra's own history is **Jira-aware**: a Run can be bound to an issue (`runs.issueRef`), so "what work touched PROJ-412?" is answerable from Coodra's records and the Context Pack is tied to the ticket.
3. At session end, **on the user's request**, the agent posts the Context Pack summary back to the linked issue as a comment, so the ticket reflects what was actually done.
4. A developer connects Jira **once** (`coodra jira enable`) and authorizes their own Atlassian account; no Coodra-side secret, no Coodra-side OAuth app.
5. Fail-open: Jira unreachable or unauthorized → the agent keeps working; the linkage and write-back are simply absent for that run.

**Non-goals (explicitly out of scope).**
- Coodra building any Jira REST client, OAuth flow, ADF converter, webhook ingress, or `jira_*` MCP tools. **Atlassian's Rovo MCP provides all of it** (§22.3, §22.4).
- Epic → Feature Pack auto-transform. An Epic is not a module blueprint (the ADR-015 lesson). Feature Packs stay human/agent-authored at module granularity.
- Jira → Coodra **push** (webhooks). Rovo is pull-only; Coodra receives no Jira events. State freshness is bounded by how often the agent reads via Rovo.
- Server-side / headless Jira access in v1 (see the caveat in §22.8).
- Jira Data Center / Server (self-hosted); Confluence / Bitbucket / JSM fusion; sprint / board mirroring.

### 22.2 The two halves — who builds what

| Atlassian's Rovo MCP provides (Coodra builds NONE of it) | Coodra builds |
|---|---|
| The Jira tools — `getJiraIssue`, `searchJiraIssuesUsingJql`, `createJiraIssue`, `editJiraIssue`, `addCommentToJiraIssue`, `transitionJiraIssue`, `getTransitionsForJiraIssue`, `getVisibleJiraProjects`, … (§22.4) | `coodra jira enable / disable / status` — wires Rovo into agent configs (§22.3) |
| OAuth 2.1 + RFC 7591 dynamic client registration + token refresh | Run ↔ issue linkage via the existing `runs.issueRef` / `context_packs.issueRef` columns (§22.5) |
| The REST client, pagination, ADF ↔ markdown | On-request Context-Pack-summary write-back via Rovo's `addCommentToJiraIssue` (§22.6) |
| Confluence / JSM / Bitbucket / Compass tools (outside Coodra's Jira scope) | Onboarding placement + trigger-contract guidance (§5.7) |

The endpoint, transport, exact tool names, OAuth shape, and per-IDE wiring are documented in `External api and library reference.md → Atlassian Remote MCP (Rovo)`. That reference is the source of truth for the wire details; this section is the source of truth for how Coodra leverages them.

### 22.3 Wiring (`coodra jira enable`)

Rovo is a **remote** Streamable HTTP MCP server at `https://mcp.atlassian.com/v1/mcp/authv2` (the `/v1/mcp/authv2` IDE-auth variant of `https://mcp.atlassian.com/v1/mcp`; the legacy `/v1/sse` endpoint is deprecated and unsupported after 2026-06-30 — Coodra wires Streamable HTTP only). `coodra jira enable` writes the server entry into each detected agent's config, the same per-IDE dispatch as `coodra graphify enable` (the `9·Core` substrate: JSON writer `external-mcp-merge.ts`, TOML writer `external-codex-merge.ts`) via a sibling `jira-wire.ts`. The one structural difference from Graphify: Graphify was **stdio** (`{ command, args }`); Rovo is **remote** (`url`). The writers therefore gain a remote/`url` entry shape per client:

- **Claude Code** (`.mcp.json`, project scope): `{ "atlassian": { "type": "http", "url": "https://mcp.atlassian.com/v1/mcp/authv2" } }`. OAuth completed interactively via `/mcp`.
- **Cursor**: `{ "Atlassian": { "url": "https://mcp.atlassian.com/v1/mcp/authv2" } }` (Cursor infers remote from `url`).
- **Windsurf** (`~/.codeium/windsurf/mcp_config.json`): `{ "atlassian": { "serverUrl": "https://mcp.atlassian.com/v1/mcp/authv2" } }`.
- **Codex** (`config.toml`): `experimental_use_rmcp_client = true` + `[mcp_servers.atlassian]` with `url = "https://mcp.atlassian.com/v1/mcp/authv2"`.
All four target agents (Claude Code, Cursor, Windsurf, Codex) support native remote MCP, so Coodra writes the **native** entry for each — **no `mcp-remote` shim** (decision 2026-05-31). A purely stdio-only client (none of the four) is simply unsupported for Jira rather than wired through a Node proxy process.

`disable` strips only the `atlassian` entry; `status` probes presence. Idempotent, never-clobber — identical guarantees to the Graphify writer.

### 22.4 Rovo's Jira tools (agent-facing; NOT Coodra-owned)

These tools appear in the agent's `tools/list` **because Rovo is wired in**, not because Coodra advertises them. They do NOT count toward Coodra's manifest — which is **20 tools** (§24.4): the 17 through Module 09 (incl. Coodra's two Jira tools `link_run_to_issue` (§22.5) and `prepare_jira_comment` (§22.6)) plus Module 10's three Deep Wiki tools (`wiki_save_structure`, `wiki_save_page`, `wiki_status`; ADR-017). The agent calls Rovo's tools directly; Coodra's role is to tell the agent *when* (the §5.7 trigger contract). The load-bearing subset:

| Rovo tool | Use |
|---|---|
| `getJiraIssue` | Read one issue by key / ID — description, status, comments, transitions. The agent's first call when a run has an `issueRef` or the user names a key. |
| `searchJiraIssuesUsingJql` | JQL search — "my open tickets" → `assignee = currentUser() AND statusCategory != Done`. |
| `getVisibleJiraProjects` | Discover accessible projects / keys. |
| `getTransitionsForJiraIssue` | Discover valid transition IDs before transitioning. |
| `transitionJiraIssue` | Move an issue between states (explicit request only). |
| `editJiraIssue` | Update fields (explicit request only). |
| `createJiraIssue` | File a new issue (explicit request only). |
| `addCommentToJiraIssue` | Post a comment — the write-back path in §22.6 (explicit request only). |

Note: the verified Rovo surface has **no dedicated issue-link tool** (the old Build design's `jira_link_issues` has no 1:1 equivalent; `getIssueLinkTypes` reads link types but no create-link write tool is exposed). If issue-linking is needed it goes through `editJiraIssue` or is deferred. Atlassian's full supported-tools list (Jira + Confluence + JSM + Bitbucket + Compass) is recorded in the reference doc.

### 22.5 Run ↔ issue linkage (Coodra's leverage, half 1)

The `runs.issueRef` and `context_packs.issueRef` columns already exist (`packages/db/src/schema.ts`) — **no migration needed.** Binding a Run to an issue makes Coodra's history Jira-aware: `query_run_history` / `query_decisions` can answer "what touched PROJ-412?" and every Context Pack carries its ticket.

**How `issueRef` is set (J2, BUILT): the `link_run_to_issue` MCP tool.** This is Coodra's one Jira MCP tool. The agent calls `link_run_to_issue { runId, issueRef }` when the user names a ticket ("work on PROJ-123") or a branch reveals one; the handler normalises the key to uppercase, idempotently updates `runs.issue_ref` (no-op when already bound; reports `previousIssueRef` on rebind), and — in team mode — enqueues a `sync_to_cloud` push of the run so cross-member history sees the link. It records a local column only — **no Jira API call** (the agent confirms the issue via Rovo's `getJiraIssue` if it needs to). An unknown `runId` returns a `run_not_found` soft-failure. This is the explicit agent-set path; a bridge-inferred fallback (branch regex / `.coodra.json` / commit trailer) remains available as future work but is not in J2. If nothing sets it, `issueRef = null` and the run proceeds normally — fail-open.

The read side is `issueRef`-aware: `query_run_history` and `query_decisions` each take an optional `issueRef` filter (case-insensitive) — that is the "what touched PROJ-412?" / "what was decided for PROJ-412?" query.

### 22.6 On-request write-back (Coodra's leverage, half 2)

At session end, **if the user asks**, the agent posts the Context Pack summary to the linked issue as a comment. The split is **Coodra assembles, Rovo posts.** Coodra's `prepare_jira_comment { runId }` (J3, BUILT) reads the run's latest Context Pack (title + excerpt) and its top decisions from Coodra's own records and returns `{ issueRef, body }` (markdown) — read-only, no Jira call. The agent then hands that `body` to **Rovo's `addCommentToJiraIssue { issueIdOrKey: issueRef, body }`**. There is no automatic worker, no `jira-post-context-summary` queue, no ADF conversion on Coodra's side (Rovo accepts markdown / handles ADF).

`prepare_jira_comment` soft-fails `run_not_found` (unknown runId) or `not_linked` (the run has no `issueRef` — call `link_run_to_issue` first). A run with no Context Pack yet still yields a valid (sparse) body from its decisions. The agent may also format the comment directly without the helper. **Unprompted writes are forbidden** — Jira is shared state and noise has a cost; the agent posts only when the user asks (§5.7).

### 22.7 Fail-open invariants (normative)

1. Rovo unreachable / not wired → the Jira tools are simply absent from `tools/list`; the agent continues with no Jira context. No Coodra code path blocks.
2. Rovo wired but unauthorized (OAuth not completed) → the tool calls fail per Rovo's own error; the agent reports it and continues. Coodra's run / linkage path is unaffected.
3. `issueRef` unresolved → `runs.issueRef = null`; the run proceeds; no linkage, no write-back. No error, no prompt.
4. Write-back declined or failed → the Context Pack is still saved locally and remains searchable. The ticket simply lacks that one comment.

There is no HMAC / webhook surface to fail (retired) — Rovo is pull-only and Coodra exposes no Jira ingress.

### 22.8 Solo vs team; the headless caveat

Both modes wire the **same** remote Rovo MCP; there is no Coodra-side credential in either. Each developer authorizes their **own** Atlassian account through the IDE's interactive OAuth (`/mcp`). There is no solo-vs-team divergence in the Jira path — unlike the Build design (which needed an API-token shim for solo and 3LO for team), Direct is uniform.

**Headless caveat.** Rovo's default is per-user interactive OAuth, which does not run in CI / cron. Atlassian *does* offer API-token auth for headless / long-running setups, but it requires an **Atlassian org-admin to enable API-token authentication** first. v1 targets interactive dev sessions and does not depend on the headless path. Server-side / headless Jira access (or a genuine need for Jira→Coodra push) is the only reason to revisit a "Build" approach later (ADR-016).

### 22.9 What was retired from the Build design

For the record (full rationale in ADR-016). Each item below was specified in the prior §22 and is **removed**:

- **8 `jira_*` MCP tools** — replaced by Rovo's tools. Coodra adds exactly TWO Jira tools — `link_run_to_issue` (§22.5) + `prepare_jira_comment` (§22.6) — so the manifest is **17** (§24.4), not the Build design's +8.
- **OAuth 2.0 3LO + the `integration_tokens` table** — Rovo owns auth; no Jira token touches Coodra's DB or a developer's laptop.
- **ADF ↔ markdown conversion** — Rovo handles it.
- **Inbound webhooks** (`POST /v1/webhooks/atlassian`), the **`integration_events`** table, the **`atlassian-webhook-event`** worker, and the webhook-renewal cron — Rovo is pull-only.
- **`IntegrationClient`** circuit-breaker / rate-limiter (for Jira) — no Coodra-side Jira calls to harden.
- **`get_feature_pack` Jira enrichment** (`jira.currentIssue` / `jira.openIssues`) and **NL-Assembly Jira injection** — the agent pulls live issue context via Rovo.
- **Lifecycle → transition automation** and **policy conditions on `issueStatus`** — out of v1; if revived, they read `runs.issueRef` + an agent-supplied status, not a Coodra-cached one.

The cross-references that mentioned these (the §3 webhook route, §16 Pattern 16, §18 NL enrichment, §21 open decisions, §24.5 manifest) are updated in the same change to point here / to ADR-016.

---

## 23. GitHub Governance & Context Layer

> **Framing:** GitHub is not another issue tracker. It is the living organizational memory of how the team *coordinates* on code — open PRs, review threads, CODEOWNERS, branch protection, check runs, team membership. These are first-class policy inputs, first-class NL Assembly inputs, and first-class agent-facing context. Where JIRA answers *"what should be done?"*, GitHub answers *"how has the team decided to do it, who owns it, and what is currently being reviewed?"*

### 23.1 Goals and Non-Goals

**Goals.**
1. Agents know which PR their current branch corresponds to, who owns the touched files (CODEOWNERS), what rules gate the target branch (branch protection / rulesets), and what reviewers have already said — without the developer pasting any of it into the prompt.
2. `check_policy` consults CODEOWNERS and branch protection as **first-class policy inputs**. Rules can reference owners, required reviewers, and required checks directly — no JSONB string matching for paths that are already encoded in `.github/CODEOWNERS`.
3. Every context pack assembly invocation of **NL Assembly** receives relevant GitHub context (PR diff summary, review comment excerpts, check statuses) alongside the run's own events and semantic diff, so enrichment output is *framed by what reviewers have been saying*.
4. The agent can query GitHub via MCP tools (`github_*`) to search PRs, read review comments, check blame, and list codeowners for a path.
5. When a context pack lands on a run with an associated PR, a summary comment is posted to that PR (symmetric to §22.8's JIRA comment).
6. Tech leads install a single Coodra GitHub App at the org level; per-project config selects which repos are in scope.
7. The integration is fail-open on every axis: GitHub down → agent continues, webhook dropped → next push/PR event reconciles, installation expired → banner but no hard stop.

**Non-goals (explicitly deferred).**
- **GitHub Actions orchestration.** Coodra does not trigger, cancel, or reconfigure workflow runs. It reads check statuses only.
- **GitHub Enterprise Server (self-hosted).** v1 is GitHub.com (cloud) + GitHub Enterprise Cloud only. GHES support is an optional later addition because the only difference is the base URL and the GitHub App installation mechanics.
- **Rewriting code via GitHub.** The agent edits files locally — `github_*` tools do not include "edit file via REST". PR creation from an agent session is a stretch goal behind a feature pack flag, default off.
- **Replacing the policy engine.** GitHub's branch protection is *consumed by* Coodra's policy engine, not the other way around. A branch rule like "requires 2 reviewers" becomes a Coodra condition; a Coodra deny policy is not pushed to GitHub.
- **Full issue tracker parity with JIRA.** `github_get_issue` exists for reading, but GitHub Issues' creation/update/transition surface is not mirrored 1:1 — teams that need that should use the JIRA integration.

### 23.2 GitHub App vs OAuth — the Authentication Split

The authentication story is the **single biggest structural difference** from the JIRA integration, and it is deliberate:

| Surface | Team mode | Solo mode |
|---|---|---|
| Auth primitive | **GitHub App installation** | Fine-grained Personal Access Token (PAT) |
| Identity | The App itself (server-to-server) | The user (as themselves) |
| Scoped per | Organization → selected repositories | A set of selected repositories |
| Token lifetime | 1 hour (installation access token) | Up to 1 year (configurable) |
| Rate limit | 5,000 req/hr per installation (up to 12,500 for large orgs) | 5,000 req/hr per user |
| Webhook source | The App (single secret per App) | Not supported without a public URL |
| Added capability | Fine-grained org-level permissions, server-to-server tokens, no user OAuth dance for background workers | Single-developer, no org-level data visible unless the user has access |

**Why GitHub App for team mode, not an OAuth App:**
- Installation tokens are **server-to-server** — BullMQ workers refresh them on a schedule without requiring a user to be logged in.
- Rate limit pool is per-installation, not per-user. A team with many agents does not burn through one developer's budget.
- A GitHub App is **identified in the UI** as a distinct actor — review comments and status checks posted by the App show up as "Coodra Bot" rather than as a confused mirror of the connecting user.
- Permissions can be *reduced* without re-installing (GitHub prompts the org owner to approve the diff).

**Why PAT for solo mode:**
- Solo mode has no public callback URL. The GitHub App OAuth flow needs one. Fine-grained PAT requires zero network callback — the user generates it at [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens) and pastes it into `~/.coodra/config.json`.
- Solo mode has no webhooks (no public ingress). Outbound-only read-heavy usage is fine at single-developer scale.

**Consequence for the architecture:**
- The `integrations` + `integration_tokens` tables from §22.2 **are reused unchanged**. The `provider` column accepts `'github'`. The token encoding differs (installation access tokens have `installation_id` in metadata), but the table shape is identical.
- A new `IntegrationClient` subclass, `GitHubClient`, swaps the Atlassian URL-building + auth refresh for GitHub's equivalents. The circuit breaker, idempotency, rate limiter, and event logging are inherited from the base class defined in §16 pattern 16.

### 23.3 Data Model Extension

No new tables beyond what §22 introduced. The polymorphic `knowledge_edges` + `integration_events` handles everything. What's new is the **set of knowledge node and edge types** that represent GitHub entities:

**New `knowledge_node_type` enum values:**
| Type | `sourceId` is | Where it lives |
|---|---|---|
| `repository` | GitHub repo node_id (global) | Mirrored in `knowledge_edges.metadata` |
| `pull_request` | `{owner}/{repo}#{number}` hashed | Mirrored; body cached for 5 min |
| `review_comment` | GitHub comment node_id | Cached for 5 min during NL assembly |
| `code_owner_rule` | Hash of `.github/CODEOWNERS` line + pattern | Parsed + cached; refreshed on push to default branch |
| `branch_protection_rule` | Branch name + rule ID | Cached; refreshed on branch protection webhook or nightly |
| `github_team` | Team `slug` within org | Cached; refreshed on team webhook or daily |
| `external_issue` (existing) | Reused for GitHub Issues, with `metadata.source = 'github'` | Same as JIRA pattern |

**New `knowledge_edge_type` enum values:**
| Edge | From → To | Meaning |
|---|---|---|
| `belongs_to_repo` | `run`, `context_pack`, `pull_request` → `repository` | Anchor every entity to a repo |
| `associated_with_pr` | `run` → `pull_request` | PR context for a session |
| `references_pr` | `context_pack` → `pull_request` | Pack addresses a specific PR |
| `owned_by_rule` | `touches_file` (existing) → `code_owner_rule` | A file match + its owning rule |
| `guards_branch` | `branch_protection_rule` → `repository` | Rule scope |
| `reviewer_is` | `pull_request` → `github_team` or `user` | Required/requested reviewer |

Everything else — the actual PR body, the review comment text, the ETag used for conditional requests — lives in `integration_events.response_body` (for audit) and in a short-TTL Redis cache (for serving). **No separate `pull_requests` table** because GitHub is the authoritative store and we should not duplicate it; we cache what's hot and recompute what's not.

**What IS persisted long-term** (beyond `integration_events` logs):

```sql
-- One row per parsed CODEOWNERS rule. Rebuilt from .github/CODEOWNERS on push to the default branch.
CREATE TABLE code_owner_rules (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id     uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  repository_full    text NOT NULL,                    -- 'owner/repo'
  path_pattern       text NOT NULL,                    -- '/apps/web/**' etc
  owners             jsonb NOT NULL,                   -- ['@org/frontend', '@alice']
  line_number        integer NOT NULL,                 -- source line for UI + traceability
  source_sha         text NOT NULL,                    -- commit SHA the rule was parsed from
  rule_order         integer NOT NULL,                 -- index within the file (last match wins in CODEOWNERS)
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamp DEFAULT now() NOT NULL
);
CREATE INDEX code_owner_rules_repo_idx ON code_owner_rules (integration_id, repository_full, is_active);

-- One row per branch protection rule. Rebuilt on branch-protection webhook or nightly refresh.
CREATE TABLE branch_protection_rules (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id           uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  repository_full          text NOT NULL,
  branch_pattern           text NOT NULL,              -- 'main', 'release/*'
  required_reviewers       integer,
  required_checks          jsonb,                      -- [{ context: 'ci/build' }, ...]
  require_code_owner_review boolean NOT NULL,
  restricts_push_to        jsonb,                      -- { users: [...], teams: [...] }
  ruleset_id               text,                       -- null for legacy branch protection; set for modern rulesets
  raw                      jsonb NOT NULL,             -- full API response for future fields
  source_sha               text,
  fetched_at               timestamp DEFAULT now() NOT NULL
);
CREATE INDEX branch_protection_repo_idx ON branch_protection_rules (integration_id, repository_full);
```

**Why these two get their own tables, when JIRA issues did not:** CODEOWNERS rules are **consulted on every `pre_tool_use` hook** for path-scoped policy decisions. Going to GitHub for this on every tool call would add a 50–200ms network hop to the hot path and blow the 150ms SLO. Branch protection is read less often but benefits from the same caching. Issues are not consulted per-tool-call; they are queried on demand. The rule of thumb: **if it's read by the 150ms hot path, materialize it locally.**

### 23.4 Repository Graph Index

The **Repository Graph Index** is the combined view of CODEOWNERS, branch protection, team membership, and active PRs for every repo in scope. It is the core data structure that makes GitHub governance *agent-consultable without latency*.

**Build flow:**
```
On integration install           On push to default branch         Nightly (03:00 UTC)
or manual re-sync:               webhook fires:                    cron job:
  - For each repo in scope:        - If changed files include        - Refresh every repo's
    · fetch CODEOWNERS               .github/CODEOWNERS:               CODEOWNERS + branch
    · parse + insert rules           · re-parse, replace rules         protection
    · fetch branch protection      - If changed files include        - Gauges drift: if local
    · fetch team memberships         .github/workflows/**:             rules differ from API,
    · cache in knowledge graph       · (noted but not consumed)        log WARN + update
```

**Index access patterns (the three hot queries):**
```
owners_for(repo, filePath) → string[]         # CODEOWNERS lookup, last-match-wins
protection_for(repo, branch) → BranchProtection | null
teams_of(owner: string) → string[]            # '@alice' → ['@org/frontend', '@org/security']
```

All three are served from Postgres in <10 ms (solo: SQLite, same shape). No GitHub call is made on the hot path.

**Freshness guarantees:**
- CODEOWNERS changes land within ~5 s of a push webhook arriving (webhook → BullMQ `github-repo-refresh` job → re-parse → write).
- Branch protection changes land within ~5 s via the `branch_protection_rule` webhook event.
- Team membership changes land within ~5 s via the `membership` event.
- Nightly refresh catches any webhook drops. Drift, if any, is logged.
- Agents consulting stale data for up to 5 s is acceptable — these rules change rarely.

**CODEOWNERS parsing rules (normative, matching GitHub's documented semantics):**
1. `#` starts a comment to end-of-line.
2. Blank lines ignored.
3. Each non-empty line: `<pattern> <owner>...`. Pattern is a gitignore-style glob, owners are `@user` or `@org/team` or `email@addr`.
4. **Last matching rule wins.** This is opposite to gitignore. Parser iterates from bottom to top and returns the first match.
5. Nested CODEOWNERS files (e.g., `apps/web/.github/CODEOWNERS`) are not supported by GitHub and not parsed.
6. Parser surfaces invalid lines (e.g., unresolvable team) as warnings attached to the integration's health panel.

The parser is a standalone pure function in `@coodra/shared/codeowners.ts`, fully unit-tested with fixtures from the official docs, and reused by both the web app (to render the "who owns this file?" panel) and the policy engine.

### 23.5 PR Context Resolution

Analogous to §22.3's `issueRef` resolution. On `SessionStart` the Hooks Bridge attempts to find the PR associated with the current branch, using this priority:

1. **Explicit adapter payload** — `"pr_ref": "owner/repo#123"` in the hook JSON (VSCode extension uses this when the user picks a PR explicitly).
2. **`.coodra.json`** — optional `"prRef": "owner/repo#123"`.
3. **Git branch → PR lookup** — `GET /repos/{owner}/{repo}/pulls?head={org}:{branch}&state=open` using the cached repository metadata. If exactly one match, use it.
4. **Commit trailer** — `GitHub-PR: owner/repo#123` in the HEAD commit message.
5. **Env var** — `COODRA_PR_REF=owner/repo#123`.

If none match, `runs.prRef = null` and GitHub governance features are silently reduced to repo-level (CODEOWNERS and branch protection still apply to the target branch; PR-specific context is simply absent).

**New `runs` and `context_packs` columns:**
- `prRef TEXT` — human-readable `owner/repo#123`.
- `repositoryFull TEXT` — `owner/repo`, always populated when a repo is known (even without a PR).

The `runs.issueRef` and `runs.prRef` are independent — a run can have both (a JIRA ticket + a GitHub PR tracking the same work). NL Assembly and policy evaluation consume both.

### 23.6 MCP Tools (Agent-Facing, 10 tools)

GitHub's surface is larger than JIRA's, so the tool list is larger. All 10 tools follow the `IntegrationClient` pattern from §22.4: take `projectSlug` + operation args, return a typed `Result<T>`, never throw.

| MCP tool | Wraps | Purpose |
|---|---|---|
| `github_get_pr_context` | REST + Graph index | One-shot bundle: the PR, its reviews, its check runs, its requested reviewers, its files, and the CODEOWNERS hits on those files. This is the **primary agent entry point** and what NL Assembly calls. |
| `github_search_prs` | `GET /search/issues?q=is:pr` | Search PRs by state/author/label/file-path. |
| `github_get_pr` | `GET /repos/{owner}/{repo}/pulls/{n}` | Raw PR detail, including description. |
| `github_list_pr_comments` | `GET /repos/{owner}/{repo}/pulls/{n}/comments` + `/issues/{n}/comments` | Combined review-comment + issue-comment thread, chronologically ordered. |
| `github_get_codeowners` | Graph index (cached) | `{ path: "apps/web/page.tsx" }` → `["@org/frontend"]`. Zero GitHub latency. |
| `github_get_branch_protection` | Graph index (cached) | `{ branch: "main" }` → policy snapshot. Zero GitHub latency. |
| `github_list_my_reviews` | GraphQL: `viewer.pullRequests(states: OPEN, involving: REVIEW_REQUESTED)` | What's waiting for the developer — helpful for cold-start "what should I work on?" |
| `github_get_blame` | GraphQL: `Blob.blame(path:)` | Who last touched which range of which file. Used by the agent when investigating "why is this here?" |
| `github_get_issue` | `GET /repos/{owner}/{repo}/issues/{n}` | Read-only issue detail. |
| `github_post_pr_comment` | `POST /repos/{owner}/{repo}/issues/{n}/comments` | Write path. Used by the Context Pack → PR comment worker (§23.11) and optionally by the agent if the policy rule `allow_agent_pr_comment` is true. |

**Tool naming convention:** `github_*` mirrors `jira_*`. No namespace conflict because MCP tool names are flat.

**GraphQL vs REST:** the client uses **GraphQL for read-heavy composite queries** (`get_pr_context`, `list_my_reviews`, `get_blame`) and **REST for write operations + simple reads** (`post_pr_comment`, `get_pr`). The split is chosen per tool based on which API minimizes round-trips. Both paths share the same rate limit budget.

**Policy gate:** each tool has a stable name (`MCP:github_post_pr_comment`, etc.) so tech leads can scope agent capabilities the same way they do for `jira_*` tools.

### 23.7 GitHub App Installation Flow — Team Mode

```
┌────────────────────────────────────────────────────────────────────────┐
│ Tech lead opens /dashboard/[project]/settings → clicks "Install GitHub"│
│                                                                        │
│ Web app → redirect to                                                  │
│   https://github.com/apps/coodra/installations/new?state=<HMAC>     │
│   ← state carries orgId + projectSlug + nonce, HMAC-signed             │
│                                                                        │
│ User picks org + repos on GitHub → GitHub redirects back to            │
│   GET /api/integrations/github/install/callback                         │
│     ?installation_id=<id>&setup_action=install&state=<HMAC>             │
│                                                                        │
│ Web app:                                                                │
│   - verify state HMAC, extract orgId + projectSlug                     │
│   - INSERT integrations (provider='github', cloud_id=installation_id,  │
│       site_url='https://github.com', display_name=<org/user login>,    │
│       scopes=<permissions from App manifest>)                          │
│   - mint first installation access token via                           │
│       POST /app/installations/{id}/access_tokens                       │
│       (using the App's private key + JWT)                              │
│   - INSERT integration_tokens (access_token, expires_at = now()+1h)    │
│   - enqueue github-repo-sync job for each selected repository:         │
│       · fetch + parse CODEOWNERS                                       │
│       · fetch branch protection for default + 'main' + 'master'        │
│       · fetch teams + members                                          │
│   - redirect to /dashboard/[project]/settings?integration=github_ok    │
└────────────────────────────────────────────────────────────────────────┘
```

**App-level JWT (used once per token mint):**
```typescript
import { createAppAuth } from '@octokit/auth-app';

const appAuth = createAppAuth({
  appId: process.env.GITHUB_APP_ID!,
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY!,          // PEM, from the App's settings page
  clientId: process.env.GITHUB_APP_CLIENT_ID,
  clientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
});

const { token } = await appAuth({
  type: 'installation',
  installationId: integration.cloudId,
});
// `token` is a 1-hour installation access token
```

**Installation permissions requested (App manifest):**
```yaml
# Repository permissions
contents:       read             # CODEOWNERS, file blobs for blame fallback
metadata:       read             # repo listing (always required)
pull_requests:  read & write     # read reviews/comments + post context pack summary
issues:         read             # github_get_issue
discussions:    read             # future: discussion-based FAQ surfacing
checks:         read             # check run statuses surfaced in NL Assembly
members:        read             # team membership resolution

# Organization permissions
members:        read             # resolve @alice → teams
administration: read             # branch protection rulesets (newer API requires this)

# Events subscribed (webhook)
pull_request, pull_request_review, pull_request_review_comment,
push, issues, issue_comment,
check_suite, check_run,
branch_protection_rule, repository_ruleset,
membership, team,
installation, installation_repositories
```

**Token refresh.** Installation tokens expire after 1 hour. The `GitHubClient` checks `expires_at` on every call, mints a new token if within 5 min of expiry, and serializes concurrent refresh attempts via a Postgres advisory lock on `integration_id`. The App's private key + `installationId` are all that's needed — no user interaction ever.

**Removing the installation.** GitHub fires an `installation.deleted` webhook. The handler sets `integrations.status = 'revoked'`, deletes `integration_tokens`, and preserves `integration_events` + the Repository Graph Index for 30 days so recent runs remain decipherable, then purges.

### 23.8 Webhook Ingress — Broader than JIRA

GitHub fires **many more event types** than JIRA, and we consume a richer subset. Signature verification, enqueuing, and idempotency follow §16 pattern 17 exactly — only the routing table changes.

**Endpoint:** `POST /v1/webhooks/github` (App-level, single secret — GitHub does not support per-installation secrets for Apps; the App's webhook secret is shared and signs every payload).

**Verification:**
```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

function verifyGitHubWebhook(rawBody: Buffer, headerSig: string, secret: string): boolean {
  // GitHub header is X-Hub-Signature-256 (SHA-256 variant; SHA-1 is deprecated)
  if (!headerSig?.startsWith('sha256=')) return false;
  const received = Buffer.from(headerSig.slice('sha256='.length), 'hex');
  const computed = createHmac('sha256', secret).update(rawBody).digest();
  return received.length === computed.length && timingSafeEqual(received, computed);
}
```

**Routing table (event → worker):**

| GitHub event | Worker | Effect |
|---|---|---|
| `installation` (`created`, `deleted`, `suspend`, `unsuspend`) | `github-installation-event` | Update `integrations.status`; on create, trigger initial graph index build. |
| `installation_repositories` (`added`, `removed`) | `github-repo-sync` | Per-repo CODEOWNERS + branch protection + team graph build or teardown. |
| `push` (on default branch) | `github-repo-refresh` | If `commits[].modified` includes `.github/CODEOWNERS` → re-parse + replace. |
| `pull_request` (`opened`, `synchronize`, `closed`, `reopened`, `edited`) | `github-pr-event` | Upsert `pull_request` node; recompute `associated_with_pr` edges; bust the PR-context cache. |
| `pull_request_review` (`submitted`, `edited`, `dismissed`) | `github-pr-event` | Invalidate NL Assembly cache; surface new review on the run timeline. |
| `pull_request_review_comment` (all actions) | `github-pr-event` | Same. |
| `check_suite`, `check_run` (completion) | `github-pr-event` | Update CI status on the PR; surface on the timeline. |
| `branch_protection_rule`, `repository_ruleset` (all) | `github-repo-refresh` | Re-fetch + upsert into `branch_protection_rules`. |
| `membership`, `team` | `github-team-refresh` | Upsert `github_team` nodes + team memberships. |
| `issues`, `issue_comment` | `github-issue-event` | Append to `integration_events`; show on run timeline if `runs.repositoryFull` matches. |
| `ping` | (no-op, 200 OK) | Verifies endpoint reachability at install time. |

**Handler budget:** 100 ms p95 for verification + enqueue + 200 OK. GitHub retries failed deliveries up to 5 times with exponential backoff, then flags the endpoint in the App's webhook delivery panel.

**Idempotency:** each webhook has an `X-GitHub-Delivery` UUID. The webhook handler uses it as the BullMQ `jobId`; a duplicate delivery hits a no-op.

### 23.9 NL Assembly Integration — The Core Path

This is the user-requested integration point. **Every context pack assembly that has a resolvable `repositoryFull` passes GitHub context into the NL Assembly LLM prompt.**

**Current (§18) NL Assembly inputs:**
- Run events (tool uses, decisions)
- Semantic diff (AST structural summary)
- Prior context pack titles for similar work (from vector search)

**Added inputs when GitHub integration is active:**
```
NL_ASSEMBLY_INPUT {
  runEvents:         [...],          // existing
  semanticDiff:      {...},          // existing
  priorPackTitles:   [...],          // existing
  github: {                          // NEW
    pullRequest: {
      number: 123,
      title: "Add OAuth refresh",
      body: "...",                    // trimmed to 1000 chars
      labels: ["backend", "security"],
      state: "open",
      draft: false,
      reviewDecision: "CHANGES_REQUESTED" | "APPROVED" | "REVIEW_REQUIRED" | null,
      requestedReviewers: ["@org/security", "@alice"],
      checkRuns: [
        { name: "ci/build",    status: "success" },
        { name: "ci/typecheck", status: "failure", summary: "apps/web/page.tsx(42): ..." }
      ],
    },
    openReviewComments: [            // up to 5, newest first, scoped to files touched in this run
      {
        author: "@bob",
        path: "apps/web/page.tsx",
        line: 42,
        body: "should use `useMemo` here, not `useEffect`",
        createdAt: "2026-04-16T09:00Z"
      }
    ],
    codeOwnersTouched: [             // deduplicated owners for all files in the run's touches_file set
      { path: "apps/web/page.tsx", owners: ["@org/frontend"] },
      { path: "packages/auth/src/tokens.ts", owners: ["@org/security"] }
    ],
    branchProtection: {
      target: "main",
      requiredReviewers: 2,
      requireCodeOwnerReview: true,
      requiredChecks: ["ci/build", "ci/typecheck"]
    }
  }
}
```

**How this modifies the NL Assembly prompt (Python, `apps/nl-assembly/prompt.py`):**

The existing enrichment prompt is extended with a GitHub-aware section. Excerpt:

```
You are summarizing a development session. Below is the run's activity, AST diff,
AND — if available — the GitHub pull request that tracks this work.

If `github` context is present, your summary MUST:
- explicitly reference the PR title and number,
- acknowledge any "CHANGES_REQUESTED" review state and what the reviewer asked for,
- flag if any file touched falls under a CODEOWNERS rule whose owners are NOT on the
  requestedReviewers list,
- surface failing check runs by name.

Output schema (unchanged):
  summary, breaking_changes, key_decisions, risk_level

Enrichment guidance — set `risk_level = "high"` if:
- reviewDecision is "CHANGES_REQUESTED" AND the run modified the file(s) being discussed, OR
- any failing check_run targets a file the run touched, OR
- the run modified a path under branchProtection.target that requires code owner review
  and the code owner is not in requestedReviewers.
```

**Result:** the context pack's `summary` now reads as e.g. *"Implemented OAuth refresh per PR #123. Addressed @bob's review comment about `useMemo` in apps/web/page.tsx:42. CI typecheck still failing on that file — next step is to re-run the type checker locally before re-requesting review."* This is a dramatically richer artifact than the pre-GitHub baseline.

**Caching:** the GitHub-enrichment fetcher in `assemble-context-pack` caches `github_get_pr_context` results for 60 s per (PR, commit SHA). Multiple concurrent runs on the same PR share one fetch.

**Failure degradation:** if any GitHub fetch fails or times out (>1 s), that field is omitted from the NL Assembly input. The LLM sees the absence, skips the GitHub section of its prompt, and produces a pack as before. The pack itself is never blocked on a GitHub call.

**Input size discipline:** review comments trimmed to 5 newest + scoped to touched files; PR body truncated to 1000 chars; check summaries trimmed to 500 chars each. Total GitHub section bounded to ~3 KB to stay inside the 4000-token Ollama budget from §18.

### 23.10 Policy Engine Integration — CODEOWNERS & Branch Protection as Conditions

The current policy engine (`apps/mcp-server/src/tools/check-policy.ts`) evaluates rules against `toolInput.file_path` using glob patterns. Two new condition types extend this with GitHub-derived facts:

**Condition: `requires_code_owner`**
```json
{
  "eventType": "pre_tool_use",
  "toolPattern": "Edit|Write",
  "conditions": {
    "requires_code_owner": ["@org/security"]
  },
  "decision": "allow",
  "decisionReason": "Security owner is on the PR"
}
```
Evaluator: look up the file in the Repository Graph Index (§23.4 — Postgres read, <10 ms). If any owner matches the condition list AND the current run's associated PR has that owner on `requestedReviewers`, allow. Otherwise, deny with a message naming the missing owner.

**Condition: `branch_is_protected`**
```json
{
  "eventType": "pre_tool_use",
  "toolPattern": "Bash",
  "commandPattern": "^git push.*--force",
  "conditions": {
    "branch_is_protected": true
  },
  "decision": "deny",
  "decisionReason": "Force push to a protected branch is denied by org policy"
}
```
Evaluator: read the current git branch from `runs.gitBranch`, look up `branch_protection_rules` by pattern match (supports `*` wildcards). If a rule exists, deny.

**Condition: `pr_state`**
```json
{
  "eventType": "pre_tool_use",
  "toolPattern": "Edit|Write",
  "conditions": {
    "pr_state": ["closed", "merged"]
  },
  "decision": "deny"
}
```
Denies edits when the run's associated PR is already closed/merged. Prevents an agent from "continuing to work" on a branch whose PR has already landed.

**Condition: `check_run_failing`**
```json
{
  "eventType": "pre_tool_use",
  "toolPattern": "Bash",
  "commandPattern": "^git push",
  "conditions": {
    "check_run_failing": ["ci/typecheck", "ci/build"]
  },
  "decision": "require_confirmation"
}
```
Returns `permissionDecision: "ask"` (Windsurf/Claude Code will prompt the developer) when the PR currently has failing check runs whose names match. Useful as a "are you sure?" guard on push.

**Implementation:** the policy engine gains a `GitHubConditionEvaluator` injected at construction (DI, §16 pattern 5). In solo mode without GitHub integration, all four conditions evaluate to `allow` (fail-open). In team mode with GitHub integration, they hit the Repository Graph Index (Postgres cache), not GitHub directly — hot path latency is unchanged.

**Why this is different from JIRA's policy hooks.** JIRA's policy condition (`issueStatus`) reads a cached property of *one* entity. GitHub's conditions evaluate facts about the **current code's relationship to the team's coordination state** — ownership, protection, review status. This is governance, not just enrichment.

### 23.11 Context Pack → PR Comment

Symmetric to §22.8. At the end of context pack assembly:

```
assemble-context-pack → context pack saved
       │
       ▼
if (run.prRef && integration.status === 'active' && featurePack.content.githubAutoComment !== false)
  enqueue github-post-context-summary { runId, contextPackId, prRef, integrationId }
       │
       ▼
github-post-context-summary worker:
  - render markdown summary (native markdown — no ADF conversion)
  - call github_post_pr_comment (idempotent via integration_events key)
  - on 201: INSERT knowledge_edge context_pack →references_pr→ pull_request
  - on error: retries 3x, then DLQ. Context pack is NOT marked failed.
```

**Comment body template:**
```markdown
### Coodra — session summary for #{prNumber}

**{title}**

{summary}

**Files changed:** {n}
**Key decisions:**
- {decision-1}
- {decision-2}
- {decision-3}

[View full run details →](https://app.coodra.dev/dashboard/{project}/runs/{runId})

---
_Posted automatically by Coodra. Disable in `feature-pack.content.githubAutoComment = false`._
```

**Opt-out** per feature pack via `githubAutoComment: false`. When both JIRA and GitHub integrations are active and a run has both `issueRef` and `prRef`, both comments are posted (they are independent workers).

### 23.12 Solo Mode — Fine-Grained PAT

```json
// ~/.coodra/config.json
{
  "local_hook_secret": "...",
  "integrations": {
    "github": {
      "token": "github_pat_...",          // fine-grained, repo-scoped, read-write where permitted
      "default_repository": "acme/myapp",  // optional; otherwise inferred from cwd git remote
      "token_expires_at": "2027-04-16"    // for UI reminder
    }
  }
}
```

**Capabilities in solo mode:**
- All read tools work (`github_get_pr_context`, `github_list_pr_comments`, `github_get_codeowners`, etc.).
- `github_post_pr_comment` works (PAT has `pull_requests: write`).
- Repository Graph Index is built locally on `coodra github refresh` or on `github_get_pr_context` first call. No webhooks → manual or periodic refresh only.
- Policy engine GitHub conditions work against the locally built index.

**What solo mode loses:**
- Webhook-driven live updates. CODEOWNERS changes require a manual `coodra github refresh` or a nightly cron.
- Post-context-pack PR comments still post, but bidirectional timeline updates (when a teammate leaves a review) are absent until the next `github_get_pr_context` call.

Solo → team migration: the PAT is discarded when the team-mode GitHub App installation completes. The migration script ensures the App has access to the same repos the PAT did (comparing `owner/repo` lists), and warns on any gap.

### 23.13 CAP Analysis

| Boundary | Choice | Justification |
|---|---|---|
| Agent → `github_*` MCP tool (reads) | AP — serve from graph index or 60 s cache | Staleness of ≤5 s (webhook lag) or ≤60 s (PR detail cache) is acceptable for context work. |
| Policy engine → Repository Graph Index | CP within local DB | Reads must be consistent with the last webhook-applied write. Postgres default isolation is sufficient. |
| Webhook ingress → Graph Index refresh | Eventual consistency | GitHub retries on our 5xx; our idempotency on `X-GitHub-Delivery` keeps it safe. |
| Context Pack → PR comment | Eventual consistency | Pack saved before comment attempted; retries async. |
| NL Assembly GitHub fetch | AP with 1 s budget | Miss → field omitted, pack still produced. |

### 23.14 Sync in Team Mode

| Table | Direction | Notes |
|---|---|---|
| `integrations` (provider='github') | cloud-only | Same as JIRA. Never leaves the cloud. |
| `integration_tokens` | cloud-only | Installation tokens live in cloud only; workers mint them. |
| `integration_events` | cloud authoritative, local append | Same pattern as JIRA. |
| `code_owner_rules` | cloud → local (pull-only cache) | Tech lead is implicitly the only writer (via webhook). Laptops pull for offline policy eval. |
| `branch_protection_rules` | cloud → local (pull-only cache) | Same. |

In solo mode these last two tables live in local SQLite and are written directly by the local workers — no cloud involved.

### 23.15 Rate Limits and Conditional Requests

GitHub caps installations at 5,000 primary requests/hr. Large orgs (>20 users) can reach 12,500. Secondary rate limits apply to burst patterns (`>60 concurrent` etc.). The integration must not burn through this carelessly — and it has a simple lever GitHub specifically encourages:

**Conditional requests with ETag** — every successful `GET` caches the response's `ETag` in Redis (team) / SQLite (solo). Subsequent requests send `If-None-Match: <etag>`; if the resource hasn't changed, GitHub returns **304 Not Modified** which **does not count against the rate limit**. This is native Octokit behavior when a cache is configured; we wire it up in the `GitHubClient` constructor:

```typescript
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';

const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId, privateKey,
    installationId: integration.cloudId,
  },
  // Throttling plugin throws on rate-limit exhaustion; we wrap in the breaker.
  request: {
    hook: etagCachingHook(redisCache),    // inserts If-None-Match; stores ETag on 2xx
  },
});
```

**Secondary-rate-limit handling.** A `403` with `x-ratelimit-remaining: 0` or a message containing "secondary rate limit" opens the circuit breaker for 60 s (twice the JIRA breaker's 30 s — GitHub's limits recover slower). The `Retry-After` header, when present, overrides the 60 s default.

**Bulk operations** (initial graph sync for a 50-repo org) use the `bottleneck` config `{ maxConcurrent: 5, minTime: 250 }` to stay well under secondary limits.

### 23.16 Fail-Open Invariants (Normative)

1. GitHub API down → all `github_*` MCP tools return `{ ok: false, error: "integration_unavailable" }`. Agent continues.
2. Installation token expired and refresh fails → `integrations.status = 'expired'`, web app banner, MCP tools return `integration_expired`. Sessions continue.
3. Webhook dropped → Repository Graph Index drifts by up to the nightly-refresh window (<24 h). No stale-data corruption because every read is "current as of last sync," not asserted-fresh.
4. Graph index miss for a file (CODEOWNERS lookup returns `[]`) → policy engine treats as no rule matched (default allow). The `requires_code_owner` condition fails open — absence of a rule ≠ denial.
5. Rate limit hit (primary or secondary) → breaker opens, all GitHub calls return `integration_unavailable` for 60 s.
6. NL Assembly GitHub fetch times out (>1 s) → GitHub section omitted from the LLM prompt. Pack still produced.
7. PR comment post fails → retried 3x, then DLQ. Context pack saved. No user-visible error.
8. Webhook HMAC mismatch → 401, payload dropped. Not fail-open (mismatch means untrusted).
9. Solo-mode PAT invalid → MCP tools return `integration_expired`. No session blocked.

### 23.17 What This Unlocks (Summary for the Reader)

With `§23` in place, every Coodra run answers these questions that were previously opaque to the agent:

- *"Who owns the files I'm about to edit?"* — CODEOWNERS hit, served from the graph index in <10 ms.
- *"Is the branch I'm on protected? By what rule?"* — Branch protection lookup, same path.
- *"Is there a PR already open for this branch? What have reviewers said?"* — `github_get_pr_context`, cached 60 s.
- *"Are CI checks failing right now?"* — Part of the PR context bundle.
- *"Has this file been recently reviewed, and by whom?"* — `github_get_blame` + cross-reference with review comments.
- *"Can I force-push to main?"* — Policy engine answers no, driven by `branch_protection_rules`.

All of it flows into the NL Assembly LLM during context pack enrichment, so the resulting context pack summarizes not just "what I did" but "what I did, in what team conversation, under which rules."

---

## 24. MCP Tool Manifest & Agent Discovery Contract

> Everything until now has described what happens once Coodra is invoked. This section addresses a prior question: **how does the agent decide to invoke Coodra in the first place?** Without a good answer here, the rest of the architecture is unreachable — hooks fire on events the agent triggers, but the agent never triggers a tool it doesn't know exists or doesn't see a reason to call.

### 24.1 The Gap This Section Closes

The MCP protocol lets a server expose tools, each with a `name`, a `description`, an `inputSchema`, and (optionally) an `outputSchema`. Clients like Claude Code, Cursor, and Copilot Chat call `tools/list` at connection time and receive the full manifest. Then — critically — the **agent's planner decides which tools to call and when, based almost entirely on the description string**.

This produces three hard requirements that previous sections left implicit:

1. **Every tool must have a description that reads like a call-site comment an agent would follow.** A description like *"returns a feature pack"* will never be called. A description like *"Call this before editing any file"* will.
2. **The set of advertised tools must be a coherent, discoverable manifest.** A tool that only exists in code but not in `tools/list` is invisible. A tool that exists in `tools/list` but has a broken handler corrupts the agent's trust.
3. **The agent needs a trigger contract** — a per-event mapping of "when this happens, call this tool" — that lives in `CLAUDE.md` / `.windsurfrules` / `.cursor/rules`. This section defines what the architecture exposes; `CLAUDE.md §5` defines what the agent is instructed to do with it.

### 24.2 Discovery Flow — the `tools/list` Handshake

```
┌─────────────┐                                       ┌───────────────────┐
│ Agent       │                                       │ Coodra MCP     │
│ (Claude     │                                       │ Server            │
│  Code, etc.)│                                       │                   │
└──────┬──────┘                                       └─────────┬─────────┘
       │                                                        │
       │ 1. initialize { clientInfo, capabilities }             │
       ├───────────────────────────────────────────────────────►│
       │                                                        │
       │ 2. initializeResult { serverInfo, capabilities.tools:{} }
       │◄───────────────────────────────────────────────────────┤
       │                                                        │
       │ 3. tools/list                                          │
       ├───────────────────────────────────────────────────────►│
       │                                                        │
       │ 4. { tools: [ {name, description, inputSchema}, ... ] }
       │◄───────────────────────────────────────────────────────┤
       │                                                        │
       │ 5. (agent's planner indexes descriptions,              │
       │     stores them for the session)                       │
       │                                                        │
       │ 6. prompts/list, resources/list (optional, unused here)│
       ├───────────────────────────────────────────────────────►│
       │                                                        │
       │ 7. tools/call { name, arguments } ...                  │
       ├───────────────────────────────────────────────────────►│
```

**When clients re-list:** most clients cache the manifest for the entire session. Re-list happens only on reconnect. Tools must be stable for a session's duration — hot-adding tools is not supported by the protocol's common clients.

**Where descriptions are rendered to the agent:** every major MCP client injects the full `tools/list` manifest (all `name + description + inputSchema` triples) into the agent's system prompt at turn-start. That means each description is effectively a standing prompt — it competes for the model's attention with every other tool. Descriptions must be concise, specific, and action-framed.

**Wire format (per MCP spec):**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "get_feature_pack",
        "description": "Call this BEFORE editing, creating, or refactoring any file in this project. Returns the Feature Pack for the module that owns the given path: architectural constraints, coding conventions, permitted files, known gotchas, and the tech lead's guidelines. Always call on the first tool use of a session and whenever switching to a new area of the codebase.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "projectSlug": { "type": "string" },
            "filePath": { "type": "string", "description": "Optional — path of the file you are about to edit. Used to resolve the correct sub-pack." }
          },
          "required": ["projectSlug"]
        }
      },
      ...
    ]
  }
}
```

### 24.3 Anatomy of a Good Description

Every Coodra tool description follows this five-part recipe. Deviation must be justified.

1. **Trigger phrase at the start.** *"Call this BEFORE editing any file..."*, *"Call this IMMEDIATELY after choosing a library..."*, *"Call this when the user asks 'what was done?'..."*. The first six words should tell the planner whether this tool is relevant to the turn at hand.
2. **What it returns, in one sentence.** The planner needs to model the response shape to decide if it answers the current question.
3. **Why the agent needs it.** One clause on consequence — *"without this, your edits will probably violate conventions the team has already decided"*.
4. **When NOT to call it (if ambiguity is likely).** Prevents the planner from firing the tool at every turn.
5. **Lowercase naming**, snake_case, no vendor prefix inside the name (we rely on the MCP `coodra__` server prefix for disambiguation).

Anti-patterns banned:
- *"Returns a feature pack."* — no trigger, no consequence.
- *"This tool retrieves X."* — third-person; the planner is not a reader of docs, it is a caller.
- *"Useful for..."* — hedging. If it's useful, say when.
- Descriptions outside the word-count envelope — **40–80 words is the soft target, 120 is the hard maximum** (amended 2026-04-23 per Q-02-6; the old ~80-word cap was too tight for tools with structured outputs that need an extra sentence of shape documentation). Character length is additionally capped at < 800 as a belt-and-braces defence against the system-prompt budget.

### 24.4 Core Tool Manifest — 20 Coodra Tools

> The live `tools/list` handshake is the source of truth — **20 tools** as of Module 10 (Deep Wiki, ADR-017). History: `query_codebase_graph` retired in G1; `seed_feature_packs_from_graph` + `build_codebase_graph` retired in ADR-015 (Graphify is query-only via its own MCP) → 15; `link_run_to_issue` (J2) → 16; `prepare_jira_comment` (J3) → 17; Module 10 added `wiki_save_structure` + `wiki_save_page` + `wiki_status` (the agent-authored Deep Wiki two-pass flow, ADR-017) → **20**. The §24.9 manifest test asserts the exact set on every push. The per-tool entries below document the load-bearing surfaces; `ping`, `list_context_packs`, `read_context_pack`, `list_features`, `get_feature`, `get_feature_file`, `query_run_diff`, and the three `wiki_*` tools are covered by that test rather than re-specced here.

These are the tools every project using Coodra exposes. They bind the agent to the Feature Pack / Context Pack / Policy / Decision lifecycle described in §2 and §18.

#### `get_feature_pack`
> Call this BEFORE editing, creating, or refactoring any file in this project. Returns the Feature Pack for the module that owns the given path: architectural constraints, coding conventions, permitted files, known gotchas, and the tech lead's guidelines. Always call on the first tool use of a session and whenever switching to a new area of the codebase. Without this, your changes will probably violate conventions the team has already recorded.

**Input:** `{ projectSlug: string, filePath?: string }`
**Returns:** `{ pack: FeaturePack, subPack?: FeaturePack, inherited: FeaturePack[] }` — `pack` is the deepest pack whose `sourceFiles` matches the given `filePath` (or the slug's own pack when `filePath` is absent / no glob matches); `inherited` is the ancestor chain of `pack`, root-first (see Module 02 S9, decisions-log 2026-04-24 15:00). `subPack` is reserved for Module 07+ folder-nested sub-feature-packs and is always `undefined`/omitted in Module 02.
**Latency target:** <50 ms (SQLite-local) or <200 ms (team mode, pgvector).
**Bridge-mediated autonomous default (Pattern 20, 2026-05-02):** the hooks-bridge fires the equivalent fetch on every Claude Code SessionStart hook and returns the pack body via `additionalContext` in the hook response. The agent therefore receives the project-level Feature Pack at turn zero **without calling this tool**. This MCP tool remains the on-demand surface for two cases: (a) mid-session module switches where the agent wants the pack scoped to a specific `filePath` argument, (b) non-Claude clients whose hook envelopes don't carry `additionalContext`. The two paths share the same `featurePack` store, so both observe the same pack content.
**Failure modes** (canonical soft-failure shape per `essentialsforclaude/09-common-patterns.md §9.1.2` — every branch carries both `error` and `howToFix`):
- `{ ok: false, error: 'pack_not_found', howToFix: string }` — the slug is not registered on disk + DB. Caller should NOT block; proceed with default conventions.
- `{ ok: false, error: 'feature_pack_cycle', chain: string[], howToFix: string }` — the `parentSlug` references in `meta.json` form a cycle. `chain` names the cyclic sequence so the user can fix the offending `meta.json`.

#### `save_context_pack`
> Call this when a feature, bug fix, or refactor is complete — not per small edit, once per completed task. Persists a markdown summary of what was built, decisions made, files modified, test results, and open TODOs to the project's context archive. This is the ONLY mechanism by which the next session (possibly a different agent) can know what was done. Skipping this leaves the run as dead weight in the history table.

**Input:** `{ runId: string, title: string, content: string, featurePackId?: string }`
**Returns:** `{ ok: true, contextPackId: string, savedAt: string, contentExcerpt: string }` on success. `contentExcerpt` is the first 500 Unicode code points of `content` with trailing whitespace trimmed (Q-02-3), returned for caller confirmation without a second read.
**Side-effect:** flips `runs.status` to `'completed'` and sets `runs.endedAt` (idempotent — no-op if the run is already completed). Optionally triggers a Context Pack → PR comment worker (§23.11); Jira write-back is on-request via Rovo's `addCommentToJiraIssue` (§22.6), not a Coodra worker.
**Bridge-mediated autonomous default (Pattern 20, 2026-05-02):** the hooks-bridge fires `contextPack.save(...)` on every Stop / SessionEnd hook with an auto-generated structured summary derived from the run's `run_events` + decisions. The agent therefore produces a Context Pack at every session end **without calling this tool**. This MCP tool remains the on-demand surface for two cases: (a) the agent has a richer, narrative summary than the auto-summary (e.g. user-asked-for-rich-recap), (b) the agent wants to save mid-session before a topic switch. Append-only semantics (ADR-007) hold for both paths: if the bridge already wrote one for the run, an explicit MCP call returns the existing row unchanged. Smarter LLM-generated auto-summaries are deferred to Module 05 (NL Assembly).
**Failure modes** (canonical soft-failure shape per `essentialsforclaude/09-common-patterns.md §9.1.2` — every branch carries both `error` and `howToFix`):
- `{ ok: false, error: 'run_not_found', howToFix: string }` — the `runId` does not match a `runs` row. Caller should call `get_run_id` first, then retry.
- Append-only re-call: if a `context_packs` row already exists for `runId`, the store returns the existing row unchanged (same `contextPackId`, same `savedAt`, original content preserved per ADR-007) — the tool responds `{ ok: true, ... }` with the original values. This is NOT a failure; it is the idempotent happy path.

#### `search_packs_nl`
> Call this when the user asks "what was done before?", "has X been tried?", or "what is the current state of Y?" — or when you are unsure whether work on a topic already exists. Natural-language search across all prior Context Packs in this project, ranked by relevance. ALWAYS call this before answering questions about prior state from memory.

**Input:** `{ projectSlug: string, query: string, embedding?: number[], limit?: number }` — `embedding` is a pre-computed 384-dim vector (Module 05 NL Assembly is the default producer; Module 02 callers without an embedder omit it and get the LIKE fallback). Amended in Module 02 S11 2026-04-24.
**Returns:** `{ ok: true, packs: Array<{ id, title, excerpt, score: number | null, savedAt, runId }>, notice?: 'no_embeddings_yet', howToFix?: string }` on success. `score` is cosine distance on the semantic path, `null` on the LIKE fallback. `notice: 'no_embeddings_yet'` + `howToFix` are emitted ONLY on the LIKE fallback path (caller did not supply `embedding`) — agents branch on `notice` presence to surface remediation.
**Mechanism:** if `embedding` is supplied with length 384, pgvector `<=>` cosine (team) or sqlite-vec `vec_distance_cosine` (solo) via `ctx.sqliteVec.searchSimilarPacks`; otherwise the LIKE fallback — `context_packs WHERE project_id = ? AND (LOWER(title) LIKE ? OR LOWER(content_excerpt) LIKE ?) ORDER BY created_at DESC LIMIT ?`.
**Failure modes** (canonical soft-failure shape per `essentialsforclaude/09-common-patterns.md §9.1.2` — every branch carries both `error` and `howToFix`):
- `{ ok: false, error: 'project_not_found', howToFix: string }` — the `projectSlug` is not registered.
- `{ ok: false, error: 'embedding_dim_mismatch', expected: 384, got: number, howToFix: string }` — the supplied `embedding` length is not 384. Handler-level check returns a structured code rather than the registry's generic `invalid_input` envelope.
**Empty results** (valid input, zero hits) are `{ ok: true, packs: [] }` — NOT a soft-failure.
**When NOT to call:** if the user's question is about the current in-flight change — use `current-session.md` from `context_memory/` instead.

#### `record_decision`
> Call this IMMEDIATELY after choosing a library, designing an API shape, selecting an implementation approach over an alternative, or deciding NOT to implement something. Persists a permanent decision entry with description, rationale, and alternatives considered. Future sessions will see these decisions and must not contradict them silently. Do not batch decisions — log each one as it is made.

**Input:** `{ runId: string, description: string, rationale: string, alternatives?: string[] }`
**Returns (success):** `{ ok: true, decisionId: string, createdAt: string /* ISO 8601 */, created: boolean }`
**Idempotency:** keyed on `dec:{runId}:{sha256(description).slice(0,32)}`. A retry with identical `description` on the same `runId` collides on the `decisions.idempotency_key` UNIQUE index, returns the original `decisionId` with `created: false`, and does NOT update `rationale` / `alternatives`. Two calls with *different* `description` values on the same `runId` persist as two distinct rows — this supports logging multiple decisions inside one run (unlike `save_context_pack` which is idempotent-per-runId).
**Storage:** dedicated `decisions` table (migration 0003), dual-dialect per §4. `run_id` is nullable + `ON DELETE SET NULL` so decision history survives the originating run's deletion — same rule as `run_events` per the 2026-04-24 widening.
**Soft-failures:**
- `{ ok: false, error: 'run_not_found', howToFix: string }` — the `runId` does not match a row in `runs`. No auto-create.
**When NOT to call:** for trivial mechanical choices (variable names, local loop structure). Reserve for choices a future agent could reasonably re-open.

#### `check_policy`
> Call this BEFORE every file write, shell command, or destructive operation. Returns "allow" (proceed), "ask" (surface to the user), or "deny" (stop). Consults project policy rules and agent-type permissions (CODEOWNERS + branch-protection integrations are future slices). If the response is "deny", DO NOT proceed under any circumstance — report the reason to the user and stop. This is the one check that must never be skipped on the file-write or bash path.

**Input:** `{ projectSlug: string, sessionId: string, agentType: string, eventType: 'PreToolUse' | 'PostToolUse', toolName: string, toolInput: object, runId?: string }`
**Returns (success):** `{ ok: true, permissionDecision: 'allow' | 'ask' | 'deny', reason: 'no_rule_matched' | 'rule_matched' | 'policy_engine_unavailable', ruleReason: string | null, matchedRuleId: string | null, failOpen: boolean }`

**Reason enum (locked in S14):**
- `no_rule_matched` — no policy rule fired; default allow (`failOpen: false`).
- `rule_matched` — an explicit policy rule decided the call; `matchedRuleId` populated, `ruleReason` is the rule's human text (`policy_rules.reason`). `failOpen: false`.
- `policy_engine_unavailable` — evaluator fault (breaker open, per-call timeout, or DB throw). Returns `allow` per §7 fail-open. `failOpen: true`.

`failOpen` is computed from `reason` (`failOpen === (reason === 'policy_engine_unavailable')`). A unit test locks the enum values — observability can rely on either axis.

**`permissionDecision = 'ask'`** is reserved for future higher-layer integrations (CODEOWNERS, branch protection). The S14 evaluator never emits `'ask'`; the schema keeps it for forward compatibility.

**Returns (soft-failure):** `{ ok: false, error: 'project_not_found', howToFix: string }` — the `projectSlug` is not registered. **Project lookup miss is NOT fail-open** — §7 fail-open covers evaluator faults, not caller-addressable errors. Module 03 (Hooks Bridge) should treat a `project_not_found` response as `allow` for hook-dispatch; otherwise a missing project registration would silently block all work (see `context_memory/decisions-log.md` 2026-04-24 S14 entry).

**Latency target:** <10 ms on the critical path. The audit-row INSERT is dispatched via `setImmediate(...)` and fires AFTER the handler returns — `policy_decisions` visibility lags the response. Retries on the same `(sessionId, toolUseId, toolName, eventType)` tuple dedupe on the `policy_decisions.idempotency_key` UNIQUE index via `ON CONFLICT DO NOTHING`. Distinct `toolUseId` values within a session land distinct rows — required for audit-trail integrity (F14).

**Storage:** audit row written to `policy_decisions` (key format `pd:{sessionId}:{toolUseId}:{toolName}:{eventType}` per §4.3 / F14 closure). The `toolUseId` input is optional on the MCP `check_policy` tool — agent harnesses pass the same `tool_use_id` they fire at the hooks-bridge so the audit row dedupes correctly across surfaces. Legacy callers that omit it fall back to the `'no-turn'` sentinel. `toolInputSnapshot` is JSON-serialised and truncated to 8 KiB with a `…[truncated:N]` suffix — prevents audit-table bloat from large-body tool inputs while preserving original-size forensics.

**Cache (S14 upgrade):** rule cache is keyed per-projectId (`Map<projectId, …>`) — one project's cached rules don't mask another's. TTL unchanged at 60s. The S7b-era `'all'` sentinel is retained as a `__global__` fallback for pre-S14 callers (registry auto-wrap) that omit `projectId`.

#### `query_run_history`
> Call this when you need to understand recent work on this project — which runs have been executed, their status, their associated PRs or JIRA issues, and the context-pack title for each completed run. Returns a chronological (most-recent-first) list of runs with metadata. Use alongside `search_packs_nl` when answering "what happened recently?" questions, and at session start to see whether there is an `in_progress` run to resume.

**Input:** `{ projectSlug: string, status?: 'in_progress' | 'completed' | 'failed', limit?: number }`
**Defaults:** `limit = 10`; upper bound `200`.
**Ordering:** `ORDER BY runs.started_at DESC` — most recent first.
**Returns (success):** `{ ok: true, runs: Array<{ runId: string, startedAt: string /* ISO 8601 */, endedAt: string | null, status: 'in_progress' | 'completed' | 'failed', title: string | null, issueRef: string | null, prRef: string | null }> }`
**`title` nullability:** derived via a LEFT JOIN on `context_packs.run_id`. Runs with no saved pack (e.g., an `in_progress` run that has not called `save_context_pack`) return `title: null`. The `context_packs(run_id)` unique index guarantees at most one join row per run.
**Empty result** (valid slug, zero matching runs) → `{ ok: true, runs: [] }` — NOT a soft-failure.
**Soft-failures:**
- `{ ok: false, error: 'project_not_found', howToFix: string }` — the `projectSlug` is not registered.

#### `query_codebase_graph` — RETIRED (Module 09 / G1, 2026-05-21)

> Removed in Module 09 (track 9B / phase G1). This tool and `apps/mcp-server/src/lib/graphify.ts` read `~/.coodra/graphify/<slug>/graph.json` — a path nothing ever populated, so the tool was permanently soft-failing. Structural queries ("blast radius", "where is X defined?", dependency paths) are now answered by **Graphify's own MCP server** (`query_graph` / `get_node` / `get_neighbors` / `shortest_path`), wired into the agent config via `coodra graphify enable`. Coodra does not wrap Graphify (ADR-010, Option C). See §17 and `docs/feature-packs/09-integrations/`.

#### `seed_feature_packs_from_graph` + `build_codebase_graph` — RETIRED (ADR-015, 2026-05-23)
> Both tools were removed. Minting one draft Feature Pack per Leiden community produced hundreds of un-injectable shells (on a real 9,659-node repo: 588 communities, 73.5% single-file — config files and READMEs), and even the module-sized ones were unreachable because `get_feature_pack`'s `filePath` resolution was never implemented and seeded packs carried `parentSlug=null`. The premise was wrong: a code-graph community is a navigation aid, not a Feature Pack boundary. Graphify remains wired as a **query-only** MCP server (`query_graph` / `get_node` / `get_neighbors` / `shortest_path`) via `coodra graphify enable`; Feature Packs stay human/agent-authored at module granularity. See ADR-015 and `docs/feature-packs/09-integrations/`.

#### `get_run_id`
> Call this at the START of any session that will write code, if the current `runId` is not already in context from a session-start hook. Returns the current in-progress session's runId (UUID) which binds all subsequent tool calls, decisions, and context packs to a single durable record. Most other tools accept this runId as an argument. Call once per session and reuse the value.

**Input:** `{ projectSlug: string }`
**Returns:** `{ runId: string, startedAt: string }`
**Mechanism:** reads the most recent `runs` row where `status = 'in_progress'` and the session matches the caller's `sessionId`. Creates one if none exists.

#### `query_decisions` (added 2026-05-03 — audit Slice 4)
> Call this when the user asks "what did we decide about X?" or "any prior decisions on Y?" or you need to reconcile your current approach against decisions recorded in earlier sessions. Returns the chronological (most-recent-first) list of decisions logged via `record_decision` for this project, optionally narrowed by a substring against description+rationale or by an exact runId. Use alongside `query_run_history` when answering "what happened recently" and as the cross-session memory primitive that `search_packs_nl` cannot serve until M05 ships embeddings.

**Input:** `{ projectSlug: string, query?: string, runId?: string, limit?: number (default 10, max 200) }`
**Returns (success):** `{ ok: true, decisions: Array<{ id, runId, description, rationale, alternatives: string[], createdAt: ISO 8601 }> }`
**Mechanism:** SELECT decisions.* INNER JOIN runs ON decisions.run_id = runs.id WHERE runs.project_id = ? [AND decisions.run_id = ?] [AND (description LIKE %query% OR rationale LIKE %query%)] ORDER BY decisions.created_at DESC LIMIT ?. The INNER JOIN excludes orphan decisions (run_id NULL after a run deletion — see schema docblock); these survive in the DB for permanent history per ADR-007 but are unreachable from this tool by design. `alternatives` is parsed from JSON-encoded string[]; pre-JSON plain-text rows surface as a single-element array.
**Soft-failures:**
- `{ ok: false, error: 'project_not_found', howToFix: string }` — the `projectSlug` is not registered. Remediation: `coodra init`.
**Empty result** (project exists, zero decisions in scope) → `{ ok: true, decisions: [] }` — NOT a soft-failure. Same rule as `query_run_history`.

### 24.5 Integration Tool Manifests — GitHub (10 Coodra tools); Jira via Rovo (external, 0 Coodra tools)

GitHub tools share a description style: each begins with *"Call this when..."* and ends with *"Returns `{ ok: true, value: ... }` on success or `{ ok: false, error }` on unavailability — never throws."*. The `Result<T>` wrapper is part of the agent-facing contract, not a leaky server detail — the agent knows to check `.ok` before reading `.value`.

#### Jira — NOT a Coodra manifest (ADR-016)

Coodra advertises **zero** `jira_*` tools. Jira is consumed Direct: `coodra jira enable` wires **Atlassian's Rovo MCP** alongside the `coodra` server, and the agent calls Rovo's own Jira tools (`getJiraIssue`, `searchJiraIssuesUsingJql`, `addCommentToJiraIssue`, `transitionJiraIssue`, …). Those tools appear in the agent's `tools/list` because Rovo is wired in, not because Coodra emits them — so they don't grow Coodra's manifest. Coodra's **two** Jira tools are `link_run_to_issue` (§22.5, binds the run to its issue key) and `prepare_jira_comment` (§22.6, the on-request write-back helper); with them the Coodra manifest is **17**. The Rovo tool surface is in §22.4; *when* the agent should call each is in `CLAUDE.md §5.7`; wire details are in `External api and library reference.md → Atlassian Remote MCP (Rovo)`. The prior 8 `jira_*` Coodra tools (Build design) are retired (§22.9).

#### GitHub (see §23.6 for wrapped endpoints)

| `name` | `description` |
|---|---|
| `github_get_pr_context` | Call this at session start when `runs.prRef` is set, and whenever you are about to edit a file while a PR is open for the current branch. Returns a one-shot bundle: PR metadata, latest reviews, check-run statuses, requested reviewers, files changed, CODEOWNERS hits on those files. This is how you learn what reviewers have already said before proposing changes. Returns `Result<PRContext>`. |
| `github_search_prs` | Call this when the user references a PR by query rather than number ("the open auth PRs", "PRs touching apps/web/"). Executes a GitHub Search API query and returns matching PRs. Note: the Search API is rate-limited at 30 req/min — avoid calling in a tight loop. Returns `Result<PR[]>`. |
| `github_get_pr` | Call this when the user references a PR by number (`#123`) and `github_get_pr_context` was not already called. Returns core PR fields without the full review/check bundle. Prefer `github_get_pr_context` if you also need reviews or checks. Returns `Result<PR>`. |
| `github_list_pr_comments` | Call this when the user asks "what did reviewers say?" or when you need to quote a specific review comment. Returns both file-level review comments and top-level PR comments, in chronological order. Returns `Result<Comment[]>`. |
| `github_get_codeowners` | Call this BEFORE editing any file in a repo with a CODEOWNERS file configured, to know who owns the change. Returns the owners matched by the given path via the local Repository Graph Index (not a live GitHub call). Returns `Result<{ owners: string[], ruleLine: string }>`. |
| `github_get_branch_protection` | Call this BEFORE a push/merge operation on a non-default branch, to know which rules will fire. Returns the merged legacy-protection + rulesets view for the given branch. Served from the local index (§23.4). Returns `Result<BranchProtection>`. |
| `github_list_my_reviews` | Call this when the user asks "what needs my review?" Returns open PRs where the authenticated user is a requested reviewer and has not yet reviewed. Returns `Result<PR[]>`. |
| `github_get_blame` | Call this when debugging or investigating why a line of code exists the way it does. Returns blame ranges for the given file path, mapping line ranges to commits and authors. Use to find the original author before making judgmental changes to their code. Returns `Result<BlameRange[]>`. |
| `github_get_issue` | Call this when the user references a GitHub issue (`owner/repo#123`) rather than a PR. Returns issue metadata and body. For PRs use `github_get_pr` instead. Returns `Result<Issue>`. |
| `github_post_pr_comment` | Call this ONLY when the policy rule `allow_agent_pr_comment` is true for this project, AND the user has explicitly asked you to post, OR the Context Pack → PR comment worker invokes it. Never auto-comment unprompted. Body is GitHub-flavored Markdown; mention-sanitization is applied inside fenced code blocks. Returns `Result<{ commentId, url }>`. |

**Why these are tables rather than full per-tool blocks:** the descriptions themselves are the contract. The wrapped endpoints, input schemas, and return shapes are already normative in §22.4 / §23.6 / `External api and library reference.md`. This section adds the one thing those sections lacked: the exact description string that reaches the agent.

### 24.6 Agent Trigger Taxonomy — what fires which tool

This table is the **source-of-truth mapping** the `CLAUDE.md §5 Agent Trigger Contract` turns into directive instructions. It is exposed here so that non-Claude agents (Cursor, Copilot, future clients) can mechanically translate the same rules into their own ruleset formats.

| Agent event / user intent | Tool(s) to call | Precondition |
|---|---|---|
| Session start | `get_run_id`, `get_feature_pack`, `query_run_history { status: 'in_progress', limit: 1 }` | Always, in parallel |
| Session start with `runs.issueRef` set | + `getJiraIssue` (Rovo) | Atlassian Rovo MCP wired |
| Session start with `runs.prRef` set | + `github_get_pr_context` | GitHub integration active |
| About to edit, create, or delete a file | `check_policy { toolName: 'Write' }` (real agent tool name: `Write` \| `Edit` \| `MultiEdit` \| `NotebookEdit` — the default policy matches these exact names), then `get_feature_pack { filePath }` if not already loaded for that area | Always |
| About to run a shell command | `check_policy { toolName: 'Bash', toolInput: { command } }` | Always |
| Chose a library / designed an API / made an implementation decision | `record_decision` | Immediately, not batched |
| User asked "what was done before on X?" | `search_packs_nl { query: X }`, `query_run_history` | Before answering from memory |
| User asked "what does this code do?" / "where is X defined?" | Graphify MCP's `query_graph` / `get_node` / `get_neighbors` / `shortest_path` — when the `graphify` server is wired (`coodra graphify enable`) | Before reading files one by one |
| User asks a structural/blast-radius question ("what depends on X?", "where is Y defined?") | Graphify's own MCP — `query_graph` / `get_node` / `get_neighbors` / `shortest_path` | Graphify wired via `coodra graphify enable` |
| User referenced a Jira key (PROJ-123) | `getJiraIssue` (Rovo) | Atlassian Rovo MCP wired (`coodra jira enable`) |
| User asked "what am I assigned?" | `searchJiraIssuesUsingJql` (Rovo) — `assignee = currentUser() AND statusCategory != Done` | Atlassian Rovo MCP wired |
| User referenced a PR number | `github_get_pr` or `github_get_pr_context` if reviews needed | GitHub integration active |
| User asked "what needs my review?" | `github_list_my_reviews` | GitHub integration active |
| User asked "who owns this file?" | `github_get_codeowners` | GitHub integration active |
| User asked "can I push to main?" — or you were about to | `check_policy` (it consults branch protection internally) | Always |
| Feature/bugfix complete, tests passing | `save_context_pack` | Exactly once per run |
| `check_policy` returned `deny` | STOP. Do NOT call other tools to \"work around\" the denial. Report to the user. | Always |

### 24.7 Where Descriptions Live in Code

Each tool's description is colocated with its handler. This is deliberate — the description is part of the contract, not a separate doc.

```
apps/mcp-server/src/tools/
  get-feature-pack/
    handler.ts         # the implementation
    schema.ts          # Zod input/output schemas
    manifest.ts        # exports { name, description, inputSchema }
    __tests__/
      handler.test.ts
      manifest.test.ts # asserts description length, trigger-phrase presence
  save-context-pack/
    ...
  index.ts             # gathers all manifest.ts exports into the tools/list response
```

`manifest.ts` exports a frozen `ToolManifest` object. The description is a normal string literal — no templating, no i18n. If it needs to change, the change is a PR that requires a matching update to `CLAUDE.md §5` if the triggers shift.

The `tools/list` handler in `apps/mcp-server/src/handlers/tools-list.ts` is a pure function: gather all `manifest.ts` exports, sort by name for determinism, return `{ tools: [...] }`. There is no dynamic gating — every installed tool is always advertised. If a tool requires an integration (JIRA, GitHub) to function, its handler returns `{ ok: false, error: 'integration_unavailable' }` when called without the integration — it does NOT disappear from the manifest. This keeps the manifest stable across session restarts and avoids the agent "forgetting" a tool exists between configurations.

### 24.8 Keeping Descriptions in Sync With Reality

Descriptions drift. The following safeguards exist:

1. **Manifest unit tests.** Each `manifest.test.ts` asserts the description via `assertManifestDescriptionValid` from `@coodra/shared/test-utils` — starts with an imperative trigger phrase ("Call this"), word count in 40–120 (soft target 40–80, hard max 120 per Q-02-6), char length in `[200, 800)`, mentions the return shape, and the manifest `name` matches the MCP pattern (and the folder name when supplied). Single helper, single source of truth for §24.3 — used by every Coodra tool manifest in `apps/mcp-server/` and future `@coodra/tools-*` packages.
2. **`tools/list` snapshot test.** `apps/mcp-server/__tests__/tools-list.snapshot.test.ts` snapshots the full `tools/list` response. A diff forces human review of every manifest change.
3. **Description-PR checklist.** Any PR that changes a `manifest.ts` file triggers a CI bot comment asking the author to confirm `CLAUDE.md §5` is still correct. See `.github/workflows/tool-manifest-check.yml`.
4. **Version stability.** Within a major version, descriptions may be clarified but not weakened. A tool's trigger phrase (the first sentence) is frozen for the major version. Adding a tool is always allowed; removing or renaming requires a major version bump.

### 24.9 Testing the Manifest End-to-End

The integration suite includes a **synthetic agent test**: a headless MCP client (using `@modelcontextprotocol/sdk`) connects, calls `tools/list`, and asserts on:

- Exactly the expected set of tools is advertised (no extras, no missing).
- Each description is shorter than 800 characters (system-prompt budget discipline).
- Each input schema is valid JSON Schema and round-trips through Ajv.
- Calling each tool with a minimal valid input returns a shape compatible with the advertised output schema — or a structured error with `ok: false`.

This test runs on every push and catches the failure mode "we added a tool but never wired it into `index.ts`" — which would otherwise only surface at the first real agent session.

### 24.10 Cross-References

- **`CLAUDE.md §5 Agent Trigger Contract`** — the agent-facing directive that turns §24.6 into instructions.
- **`§3.5 MCP Transport`** — stdio + HTTP transport mechanics.
- **`§16 Design Pattern 19: Tool descriptions are agent prompts`** — the pattern abstraction.
- **`§22.4` / `§23.6`** — wrapped endpoints and input/output shapes for the integration tools.
- **`External api and library reference.md § Model Context Protocol`** — `@modelcontextprotocol/sdk` wiring for server registration.

---

## Summary: The Four Principles + Two New Ones

### Carried from prototype:
1. **Never block the agent.** Every error path defaults to allow/continue.
2. **Respond first, record second.** DB writes never sit in the critical path of a hook response.
3. **Make every write idempotent.** Retries, crashes, and replays produce the same state.
4. **Type safety from schema to wire.** Drizzle → Drizzle types. Zod → TS types. No manually maintained interfaces.

### New in v2:
5. **Mode is a storage adapter, not a code fork.** Solo and team share all service logic. The adapter pattern means `if (mode === 'solo')` never appears in business code.
6. **Normalize at the boundary, not at the core.** Each agent's specific payload shape is translated to `HookEvent` exactly once, at ingress. Everything downstream is agent-agnostic.
