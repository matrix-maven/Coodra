# Coodra Functional Test — Agent Operating Guide

> **You are the test pilot.** You will pick a project, research it, define its
> features using Coodra, then build the project end-to-end through Claude
> Code while continuously verifying that every Coodra surface (CLI, web,
> bridge, MCP, DB, logs) reflects what you did.
>
> You have **zero starting context** about this environment. This document is
> your single source of truth. Read it once front-to-back before starting.
> Then keep it open while you work.

---

## 0. Your mission in one paragraph

Use Coodra to take a real, **substantial** project from "blank folder" to
"working implementation" across **multiple Claude Code sessions** entirely
through the tool. The point is not to finish quickly — the point is to stress
Coodra over a realistic multi-day, multi-session timeline where the agent
must remember what was decided, why, and what's still open. Pick a project
big enough that it cannot fit in one session. Define **6–10 accurate
features** with real, useful markdown (not stubs), upload supporting files
for each, then run **at least 4 separate Claude Code sessions** that pick up
where the last one left off. At every step, **verify by reading the
underlying surface** (disk, SQLite, bridge response, MCP tool result, web
route HTML). Write what you observe into `Coodra_functest/` continuously
so the test is self-documenting. End with a report describing what worked,
what didn't, and — critically — whether Coodra actually held the project's
context across sessions the way it claims to.

> **The single most important thing this test is measuring:** does Session 4
> open with full awareness of what Sessions 1–3 decided, built, and left
> unfinished? If yes, Coodra works. If the agent has to be re-briefed by
> hand at the start of each session, Coodra doesn't work yet — and that's
> the most valuable signal you can produce.

---

## 1. The product you're testing

Coodra is the coordination layer between human architects and AI coding
agents. It runs three local services and exposes four surfaces:

| Layer | Service | Port | Purpose |
|---|---|---|---|
| Protocol | **Hooks Bridge** | `3101` | Receives Claude Code's `SessionStart`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`, `UserPromptSubmit` HTTP hooks. Auto-injects the project's features index on `SessionStart`. Auto-records a context-pack digest on `Stop`. |
| Protocol | **MCP Server** | `3100` | Streamable-HTTP MCP endpoint. Exposes 30+ tools (`list_features`, `get_feature`, `record_decision`, `save_context_pack`, `query_decisions`, `query_run_history`, `check_policy`, `get_feature_pack`, etc.) |
| Storage | **SQLite primary store** | n/a | `~/.coodra/coodra.db`. Holds projects, runs, run_events, decisions, context_packs, feature_packs, policies, policy_rules, policy_decisions. |
| Client | **Web app (Next.js)** | `3001` (dev) | Read/write UI for projects, features, packs, runs, decisions, policies. |

Per project, Coodra keeps content on disk under the project root:

```
<project>/
├── .coodra.json               # { projectSlug }
├── .mcp.json                     # tells Claude Code where to find the MCP server
├── .env                          # contains LOCAL_HOOK_SECRET for the bridge
├── docs/
│   ├── features/                 # ⭐ the skill-style features layer (NEW)
│   │   ├── INDEX.md              # auto-generated, human-readable
│   │   ├── INDEX.json            # auto-generated, machine-readable
│   │   └── <slug>/
│   │       ├── feature.md        # frontmatter + body (the skill itself)
│   │       └── examples/...      # supporting files
│   └── feature-packs/            # legacy per-project pack (still works)
│       └── <projectSlug>/
│           └── spec.md, etc.
```

The **features layer** is what you're testing first. Every feature is a
self-contained markdown unit with a *trigger description* ("Use this when
…"). On `SessionStart`, the bridge injects a tiny index of triggers into
Claude's context. When Claude decides a feature applies, it calls
`coodra__get_feature({slug})` to load the full body. Skill-style:
**index then fetch on demand**.

---

## 2. Environment map — where everything lives

| Thing | Path / URL |
|---|---|
| Repo root (the product) | `/Users/abishaikc/Coodra` |
| CLI binary (no global install) | `node /Users/abishaikc/Coodra/packages/cli/dist/index.js` |
| MCP server | `http://127.0.0.1:3100/mcp` |
| Hooks bridge | `http://127.0.0.1:3101/v1/hooks/claude-code` |
| Bridge health | `http://127.0.0.1:3101/healthz` |
| Web app (dev) | `http://127.0.0.1:3001` |
| Local SQLite primary store | `~/.coodra/coodra.db` |
| Service logs | `~/.coodra/logs/{mcp-server,hooks-bridge,sync-daemon}.log` |
| Templates available to `init` | `node $CLI templates list` |
| Your observation folder (the user supplies this) | `Coodra_functest/` (use absolute path the user gives you) |

**Per-project secret you'll need:** after `coodra init` runs, every project
gets a `.env` file containing `LOCAL_HOOK_SECRET=<random-hex>`. The bridge
requires this secret in the `X-Local-Hook-Secret` header on every hook POST.
Claude Code reads it from the project's `.env` automatically; for `curl`
probes you read it the same way:

```bash
SECRET=$(grep LOCAL_HOOK_SECRET <project>/.env | cut -d= -f2)
```

**The CLI alias** — set this once at the top of every terminal you open:

```bash
export CLI=/Users/abishaikc/Coodra/packages/cli/dist/index.js
alias coodra='node $CLI'
```

After this you can run `coodra status` / `coodra feature list` / etc.
verbatim from any cwd.

---

## 3. Service control

### 3.1 Start / stop / status

```bash
coodra start                  # boots mcp-server + hooks-bridge (+ sync-daemon if team mode)
coodra stop                   # idempotent
coodra status                 # unified project + service state for current cwd
coodra doctor                 # 11 essential health checks; --full for 35
```

### 3.2 Sanity-check the services are actually up

```bash
# Ports
lsof -iTCP:3100 -sTCP:LISTEN -P 2>/dev/null   # MCP
lsof -iTCP:3101 -sTCP:LISTEN -P 2>/dev/null   # bridge
lsof -iTCP:3001 -sTCP:LISTEN -P 2>/dev/null   # web (only if you started it)

# Bridge health (no auth needed)
curl -sf http://127.0.0.1:3101/healthz

# Tail the logs (keep this running in a separate terminal — see §8)
tail -f ~/.coodra/logs/mcp-server.log     | npx pino-pretty
tail -f ~/.coodra/logs/hooks-bridge.log   | npx pino-pretty
```

### 3.3 If the MCP server says `Server already initialized`

The Streamable-HTTP transport sometimes leaves a session alive. **Always
restart between independent MCP probe scripts:**

```bash
coodra stop && sleep 1 && coodra start
```

This is a known operational quirk for ad-hoc MCP probes — Claude Code itself
doesn't hit it because it owns its session for the lifetime of the IDE.

### 3.4 Web app

The web app isn't started by `coodra start` — start it yourself in its own
terminal:

```bash
cd /Users/abishaikc/Coodra && pnpm --filter @coodra/web-v2 dev
# It runs on :3001 in dev (set in apps/web-v2/package.json).
```

---

## 4. The mission, in phases

Work through these in order. Each phase ends with you writing a numbered
observation file into `Coodra_functest/` — see §7 for the format.

### Phase 1 — Pick a project

**Pick something boring and big.** This is not a chance to be clever — it's a
chance to test whether Coodra holds context over a realistic build. Pick a
shape with these properties:

- **Multi-session by construction.** No human could plausibly build it in one
  Claude session. Plan for 4–8 sessions minimum.
- **Mostly conventional.** Boring CRUD with auth, jobs, validation, tests —
  not novel research. Less innovation = more surface area to test, because
  the agent should be doing the *expected* thing at every turn and you can
  catch it doing something unexpected.
- **6–10 distinct concerns** that map naturally to features. Each feature
  should be invokable independently — i.e., a slice can touch one or two
  features at a time, not all of them.
- **Has a runnable artifact at the end.** You will run it and it will work.
  Theoretical exercises don't count.

Good shapes (pick one or invent something equivalent):

| Project | Why it's a good test |
|---|---|
| **Personal finance tracker REST API** — Express + Postgres, JWT auth, transactions, categories, budgets, monthly reports, CSV import, recurring rules engine, audit log | 8–10 features, real domain logic in the rules engine, exercise of every CRUD pattern, plenty of "wait, where did we decide X?" moments across sessions |
| **Habit-tracker backend** — Fastify + SQLite, user auth, habits CRUD, daily check-ins, streak calculation, push-notification scheduling, weekly digest worker, GraphQL read API | Background jobs + scheduled workers force the agent to remember the queue conventions across sessions |
| **Recipe/meal-planning service** — NestJS + Postgres, recipes CRUD, ingredient DB, weekly meal-plan generation, shopping-list rollup, allergy filters, image upload to S3-compatible storage | Lots of related domain entities — perfect for testing whether the agent re-reads the right feature when switching from "recipes" to "meal-plans" |
| **Document workflow tool** — Next.js + Postgres, document upload, version history, approval chains with role-based routing, comment threads, email notifications, audit trail, full-text search | Role-based logic + workflow state machines — the kind of thing where forgetting a prior decision causes silent data corruption |
| **Internal admin dashboard for an e-commerce backend** — Next.js + Drizzle + Postgres, product catalogue, inventory, orders, refunds, customers, coupon engine, order-status webhooks, basic analytics | Largest surface; closest to "real production app"; will absolutely span many sessions |

Avoid: anything that needs paid APIs to *function* (Stripe live mode, sending
real SMS/email), anything that requires a browser extension, anything where
the novelty itself is the point. This is a stress test for the **tool**, not
your portfolio.

Whatever you pick, write `00-overview.md` first with: the chosen project, the
6–10 feature areas you'll define in Phase 4, and your guess at how many Claude
sessions you'll need.

### Phase 2 — Research

Spend time understanding what you're building before writing a line of
code. Capture:

- **Goal in one sentence.** What does the finished thing do?
- **User flow.** Walk through how someone uses it, end to end.
- **Component decomposition.** What are the 4–6 distinct concerns? These will
  become your features.
- **Decisions you've already made.** Language, framework, storage, deployment.

Write `01-research.md` in the observation folder.

### Phase 3 — Set up the project in Coodra

```bash
mkdir -p ~/projects/<project-name>
cd ~/projects/<project-name>
git init -q && touch README.md && git add . && git commit -qm "init"

coodra init --feature-pack empty --no-graphify --ide claude --mode default
```

Verify the four artifacts landed:

```bash
ls -la                              # .coodra.json .env .mcp.json docs/
cat .coodra.json                 # confirm projectSlug
cat .mcp.json                       # confirm coodra entry
ls docs/feature-packs/              # empty/.gitkeep
```

Now confirm Coodra itself knows about the project:

```bash
coodra status                    # should print project slug + service state

sqlite3 ~/.coodra/coodra.db \
  "SELECT slug, cwd, created_at FROM projects WHERE slug='<your-slug>';"
```

Hit the web:

```bash
curl -sf http://127.0.0.1:3001/projects/<your-slug> | grep -oE "<your-slug>" | head -1
```

Write `02-setup.md`. Include the slug, project path, and the four-line `ls -la`
output.

### Phase 4 — Define features (the new onboarding pivot) — the most important phase

This is the phase the rest of the test rests on. **Garbage features =
garbage test.** If the descriptions are vague stubs, Claude won't know which
feature applies to which prompt, and you'll be effectively testing a
context-less Claude with extra steps.

Every feature you create must hit **all four** quality heuristics:

1. **Starts with an imperative verb** — `Use this when…`, `Apply this to…`,
   `Reference this before…`. Not "this is about" / "documentation for".
2. **≥30 chars.** A real trigger sentence, not a label.
3. **No `TODO`.** Stub language is auto-flagged. Replace placeholders before
   indexing.
4. **Mentions a concrete signal** — a file path, function name, route prefix,
   table name, error code, or a domain noun specific to your project. This
   is what lets Claude pick the right feature from the index.

The body (everything after the YAML frontmatter) must contain real, useful
prose — not the template stub. Concretely:

- **What this feature is** — 2–4 sentences. What concern does it own?
- **Concrete operations / entities** — file paths, function names, route
  prefixes, table names. These are the hooks Claude grep-matches against.
- **Things to watch out for** — invariants, race conditions, error envelopes,
  conventions other features assume.
- **Cross-references** — `Use \`auth-flow\` when issuing tokens; this feature
  only verifies them.` Tell future-Claude which sibling feature owns the
  thing it's reaching for.

Supporting files under `docs/features/<slug>/` are loaded on demand via
`get_feature_file`. Use them for: example code, sample requests/responses,
SQL schemas, sequence diagrams as ASCII, decision tables. **Aim for 1–3
supporting files per non-trivial feature.**

#### Worked example — what a real feature.md looks like

Below is `docs/features/auth-flow/feature.md` for a hypothetical habit
tracker (Fastify + SQLite + JWT). This is the level of accuracy your features
must hit. Feel free to adapt for your project.

```markdown
---
name: auth-flow
description: Use this when wiring login, signup, password reset, or JWT issuance/verification. Covers the bcrypt cost factor, the access/refresh token split, and the `JWT_SECRET` rotation contract. Touches `apps/api/auth/**` and the `users` + `refresh_tokens` tables.
maturity: stable
owners: [backend]
tags: [auth, jwt, security]
---

# auth-flow

> The body of this feature is what the agent loads on demand via
> `coodra__get_feature({slug:"auth-flow"})`. Read this before touching
> anything under `apps/api/auth/**`.

## What this feature owns

Authentication only. Specifically: how a request becomes an authenticated
request. It does NOT own authorization (that's `permissions`), session
storage in the browser (that's the front-end's job), or rate-limiting login
attempts (that's `rate-limit`).

Concretely, this feature covers:

- Signup (`POST /auth/signup`) → bcrypt hash → row in `users` → issue tokens
- Login (`POST /auth/login`) → verify hash → issue tokens
- Refresh (`POST /auth/refresh`) → rotate refresh token → re-issue access
- Logout (`POST /auth/logout`) → invalidate refresh token row
- Verify middleware (`requireAuth`) attached to every protected route

## Concrete operations / entities

| What | Where |
|---|---|
| Routes | `apps/api/auth/routes.ts` |
| Service layer | `apps/api/auth/service.ts` |
| Token issuance + verification | `apps/api/auth/tokens.ts` |
| `users` table | `migrations/0001_users.sql` |
| `refresh_tokens` table | `migrations/0003_refresh_tokens.sql` |
| `requireAuth` Fastify hook | `apps/api/middleware/require-auth.ts` |
| Tests | `apps/api/auth/__tests__/*.test.ts` |

## Token contract

- **Access token** — JWT, 15 min TTL, signed with `JWT_SECRET`, claims:
  `{ sub: userId, iat, exp, kind: 'access' }`. Sent as
  `Authorization: Bearer <jwt>`.
- **Refresh token** — opaque 32-byte hex, 30 day TTL, stored hashed
  (sha256) in `refresh_tokens.token_hash`. Sent as `httpOnly; secure;
  sameSite=strict` cookie named `__Host-rt`.
- Refresh rotates: every `/auth/refresh` invalidates the old row and inserts
  a new one.

## Things to watch out for

- **bcrypt cost factor is 12.** Anything lower is rejected by the test in
  `apps/api/auth/__tests__/hash-cost.test.ts`. Don't lower it for "speed."
- **Never log the raw refresh token.** It's a bearer credential.
- **`JWT_SECRET` rotation:** when rotating, support BOTH the new and the
  previous secret for one access-token TTL window (15 min) so in-flight
  requests don't fail. Implementation: `tokens.ts::verifyAccess` tries
  current then previous.
- **Refresh-token reuse detection:** if a refresh token is presented twice,
  invalidate the entire refresh-token chain for that user (someone replayed
  a stolen token). Test: `__tests__/refresh-replay.test.ts`.
- **Don't roll your own.** Use `@fastify/jwt` and `bcrypt` exactly as wired in
  `tokens.ts`. The custom code is the rotation logic, not the crypto.

## Sibling features you'll touch

- `permissions` — owns RBAC checks. This feature only proves identity.
- `rate-limit` — applies the per-IP throttle to `/auth/login` and
  `/auth/signup`. Wired in `apps/api/server.ts`, not in this feature's code.
- `audit-log` — records every login / refresh / logout event. Hook in
  `service.ts::onAuthEvent`.

## Supporting files

- `examples/login-request.http` — copy/pasteable curl for local dev
- `examples/jwt-claims.json` — sample decoded payload
- `examples/refresh-rotation.sql` — the exact SQL the rotation runs
```

That's a real feature. Notice: the description is a single sentence packed
with concrete signals (`apps/api/auth/**`, `JWT_SECRET`, `users` table). The
body has file paths, table names, a token contract, named tests, named
sibling features. A future Claude session reading this knows exactly what
this feature owns and what it doesn't.

#### How to author this efficiently

Don't try to write all 6–10 features perfectly upfront. Iterate:

1. Stub each one with `feature add <slug> --description "<one good sentence>"`
   (using all three creation paths below — CLI, web wizard, import).
2. Run `feature list` and confirm the description column is readable.
3. Open each `feature.md` and replace the body template with real content
   per the worked example above.
4. Drop supporting files into `docs/features/<slug>/examples/` (1–3 files).
5. Run `feature index` once. Confirm 0 warnings.

#### Use all three creation paths so we exercise everything

#### Path A — CLI

```bash
coodra feature add auth-flow --description "Use this when wiring login, signup, password reset, or JWT issuance. Covers bcrypt cost, access/refresh token split, and JWT_SECRET rotation. Touches apps/api/auth/** and the users + refresh_tokens tables."
coodra feature list
coodra feature show auth-flow
```

#### Path B — Web wizard

Open `http://127.0.0.1:3001/projects/<your-slug>/features/new` in a browser.
The "Description (the agent's trigger)" field has a live quality hint — all
four heuristics light up green when you've passed them. Don't submit while
any are red.

After submitting, edit the body either via the web edit form
(`/features/<fslug>/edit`) or directly in `docs/features/<fslug>/feature.md`
on disk. Both write to the same place; the indexer regenerates on every read.

#### Path C — Import existing markdown

If you already have docs that explain a concern, promote them. Drop a
markdown file under `docs/`, `specs/`, or `architecture/`, then visit
`/projects/<your-slug>/features/import`. The wizard scans, suggests slugs
and descriptions (it pulls the first non-heading line as the trigger
candidate), and lets you check off which to promote. Tighten the suggested
description before submitting — first lines of docs are rarely
imperative-shape.

```bash
# Seed an import candidate so the wizard finds it
mkdir -p docs && cat > docs/streak-calc.md <<'EOF'
# Streak calculation

Use this when computing a habit's current streak, longest streak, or
weekly completion percentage. The algorithm walks `daily_check_ins` for
the last 365 days and applies the freeze rules from
`apps/api/streaks/rules.ts`.
EOF
```

#### Verify supporting files load through every layer

```bash
mkdir -p docs/features/auth-flow/examples
cat > docs/features/auth-flow/examples/login-request.http <<'EOF'
POST http://localhost:3000/auth/login
Content-Type: application/json

{"email":"alice@example.com","password":"correct horse battery staple"}
EOF

cat > docs/features/auth-flow/examples/jwt-claims.json <<'EOF'
{"sub":"u_01HX...","iat":1714780800,"exp":1714781700,"kind":"access"}
EOF

coodra feature index           # idempotent — also auto-runs on add/edit/remove

# Confirm via MCP that the file is reachable
node ~/mcp-probe.mjs get_feature_file \
  '{"projectSlug":"<your-slug>","slug":"auth-flow","path":"examples/login-request.http"}' \
  "$PWD"
```

#### Verify the features layer at every layer

```bash
# Disk
cat docs/features/INDEX.md
cat docs/features/INDEX.json | python3 -m json.tool | head -40
ls docs/features/<slug>/

# Bridge — what does Claude actually receive on SessionStart?
SECRET=$(grep LOCAL_HOOK_SECRET .env | cut -d= -f2)
curl -sf -X POST http://127.0.0.1:3101/v1/hooks/claude-code \
  -H 'Content-Type: application/json' \
  -H "X-Local-Hook-Secret: $SECRET" \
  -d "{\"session_id\":\"probe-$RANDOM\",\"hook_event_name\":\"SessionStart\",
       \"transcript_path\":\"/tmp/t.jsonl\",\"cwd\":\"$PWD\",\"source\":\"startup\"}" \
  -o /tmp/sess.json
python3 -c '
import json
with open("/tmp/sess.json") as f: r = json.load(f)
ctx = (r.get("hookSpecificOutput") or {}).get("additionalContext") or ""
print(f"injected {len(ctx)} chars; first 800:")
print(ctx[:800])
'

# MCP
node <<'NODE'
import('/Users/abishaikc/Coodra/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js').then(async ({Client}) => {
  const {StreamableHTTPClientTransport} = await import('/Users/abishaikc/Coodra/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js');
  const t = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3100/mcp'));
  const c = new Client({name:'probe',version:'0.1'},{capabilities:{}});
  await c.connect(t);
  const r = await c.callTool({name:'list_features', arguments:{projectSlug:'<your-slug>'}, _meta:{cwd:process.cwd()}});
  console.log(JSON.stringify(r.structuredContent, null, 2));
  await c.close();
});
NODE

# Web
curl -sf http://127.0.0.1:3001/projects/<your-slug>/features | grep -oE "<slug>"
```

Write `03-features.md` with a one-line entry per feature: slug, description,
file count, how it was created (CLI/wizard/import).

### Phase 5 — Build the project through Claude Code, across multiple sessions

This is the primary test. Plan for **at least 4 separate Claude Code
sessions**, with deliberate gaps between them, building one or two slices
per session. Each session must:

1. **Open cold.** Close the previous Claude Code session entirely. Don't
   resume — the test is whether the *next* session can pick up where the
   last left off using only what Coodra persisted.
2. **Receive its context via the bridge.** Watch the bridge log (Terminal B)
   to see the SessionStart fire and inject the features index +
   prior-session digest.
3. **Drive its work via the features.** The first prompt of every session
   should reference the relevant feature(s) by slug. Claude should call
   `get_feature` to load the body. If it doesn't, that's a finding —
   capture it.
4. **Record decisions in real time.** Whenever Claude makes a design choice,
   it should call `record_decision`. If you watch a session go by with no
   `record_decision` calls in the MCP log, that's a finding too.
5. **End with a context pack.** Tell Claude "we're done — save the context
   pack" before closing the session. Verify it lands in DB.

#### Session plan (template — adapt to your project)

| # | Slice | Features touched | Expected outcome |
|---|---|---|---|
| 1 | Foundation | `data-model`, `http-routing`, `testing` | Migrations, server bootstrap, one trivial route, vitest config, CI green |
| 2 | Auth | `auth-flow`, `data-model`, `testing` | Signup/login/refresh/logout, `requireAuth` middleware, all auth tests passing |
| 3 | Core domain (slice 1) | `<domain-feature-1>`, `data-model`, `http-routing` | First domain entity end-to-end with tests |
| 4 | Core domain (slice 2) | `<domain-feature-2>`, `<domain-feature-1>`, `testing` | Second entity + cross-entity logic |
| 5 | Background work | `jobs`, `<domain-feature-2>` | BullMQ wiring, one scheduled worker, integration test |
| 6 | Polish + glue | every feature | Error envelope unified, audit log fired across mutations, end-to-end smoke |
| 7 | Final pass | every feature | Run the thing, fix what's broken, write release notes |

Adjust to your project — but keep the **multi-session** shape.

#### Sample prompts that exercise the mechanism

Session 1, opening prompt:

> "We're building `<your-project>`. Coodra just injected the features
> index — read `data-model`, `http-routing`, and `testing` in full before
> writing anything. Then implement Slice 1: migrations for the core tables,
> server bootstrap on port 4000, a single `/healthz` route, and the vitest
> setup. Record a decision when you pick the runtime (Fastify vs Express)
> with rationale. We're done when `pnpm test` runs green and `curl
> /healthz` returns 200."

Session 2, opening prompt (cold start, separate Claude Code instance):

> "Resume `<your-project>`. The previous session built the foundation.
> Before you do anything, check what's already done: call
> `query_run_history` to see the last run, `query_decisions` to see what
> was decided, and read the most recent context pack via
> `search_packs_nl`. Then load `auth-flow` and start Slice 2."

The wording matters. The first session sets the precedent; later sessions
explicitly invoke the persistence path so you can verify it.

#### After each Claude session — verification drill

In Terminal D (verification scratch):

```bash
# 1. Did the run open and close cleanly?
sqlite3 ~/.coodra/coodra.db <<'SQL'
.headers on
.mode column
SELECT id, agent_type, status, started_at, completed_at,
       (julianday(completed_at) - julianday(started_at)) * 86400 AS duration_sec
FROM runs ORDER BY started_at DESC LIMIT 3;
SQL

# 2. Were decisions recorded? (Aim for ≥2 per slice; <1 is a finding.)
sqlite3 ~/.coodra/coodra.db <<'SQL'
.headers on
.mode column
SELECT created_at, description, rationale
FROM decisions
WHERE run_id = (SELECT id FROM runs ORDER BY started_at DESC LIMIT 1);
SQL

# 3. What tools did Claude actually call? (Look for the right pattern:
#    get_feature at the start, record_decision sprinkled, save_context_pack
#    at the end.)
sqlite3 ~/.coodra/coodra.db <<'SQL'
.headers on
.mode column
SELECT event_type, tool_name, COUNT(*) AS n
FROM run_events
WHERE run_id = (SELECT id FROM runs ORDER BY started_at DESC LIMIT 1)
GROUP BY event_type, tool_name
ORDER BY n DESC;
SQL

# 4. Did any policy fire? (Useful: did anything get denied?)
sqlite3 ~/.coodra/coodra.db <<'SQL'
.headers on
.mode column
SELECT tool_name, permission_decision, reason, created_at
FROM policy_decisions
ORDER BY created_at DESC LIMIT 10;
SQL

# 5. Was the context pack saved? Length should be > 1000 chars for a real slice.
sqlite3 ~/.coodra/coodra.db <<'SQL'
.headers on
.mode column
SELECT id, title, length(content) AS body_chars, created_at
FROM context_packs ORDER BY created_at DESC LIMIT 3;
SQL

# 6. Open the latest context pack in the web UI for a human read:
#    http://127.0.0.1:3001/projects/<your-slug>/runs/<latest-runId>
```

Write `04-build-slice-N.md` after each slice (one file per Claude session).
Critically, in `04-build-slice-2.md` and onwards, answer this question
explicitly:

> **Did this session open with awareness of what the previous session
> did?** (yes / partial / no — with evidence: which features Claude loaded,
> whether it referenced prior decisions, whether it duplicated work.)

That single question is what the entire test is for.

#### Between sessions — simulate "the next morning"

Don't rush from session to session. Between sessions:

- Close Claude Code completely.
- Wait at least a few minutes (so it's not the same process picking up the
  same in-memory state).
- Optionally restart the bridge + MCP (`coodra stop && coodra start`)
  to prove the persistence is on disk, not in process memory.
- Read the `context_packs` row from the previous run yourself before
  starting the next session, so you know what Claude *should* know.

### Phase 6 — Stress-test the surfaces

While the project is "working," exercise things that should break the right way:

```bash
# Path traversal — should be rejected at the input schema layer
node <<'NODE'
... (call get_feature_file with path: '../../../etc/passwd')
NODE

# Blocked extension
echo "x" > docs/features/<slug>/payload.exe
... (call get_feature_file with path: 'payload.exe' — expect extension_blocked)

# Oversized file — expect file_too_large
dd if=/dev/zero of=docs/features/<slug>/huge.txt bs=1024 count=300
... (call get_feature_file with path: 'huge.txt')
rm docs/features/<slug>/huge.txt docs/features/<slug>/payload.exe

# Unknown project
... (call list_features with projectSlug: 'never-existed' — expect project_not_found)

# Unknown feature
coodra feature show does-not-exist
... (call get_feature with slug: 'does-not-exist' — expect feature_not_found)

# Idempotent re-index
coodra feature index    # first call may regenerate
coodra feature index    # second call should print "Index unchanged"

# Hand-edit propagation
# Edit docs/features/<slug>/feature.md by hand. Then:
#   - re-hit SessionStart curl — bridge should reflect the change
#   - call list_features — MCP should reflect the change
#   - reload web list — UI should reflect the change
# (No CLI run required — readers regen on read.)
```

Every soft-failure must come back as `{ ok: false, error: '<stable-code>',
howToFix: '<actionable string>', ...extras }`. Hard rejections (path
traversal, malformed input) come back as `invalid_input` with Zod issues.

Write `05-stress.md`.

### Phase 7 — Final report

Write `99-report.md`. Format in §10.

---

## 5. Surfaces — CRUD reference

### 5.1 CLI commands

```bash
# Lifecycle
coodra init [--feature-pack template|empty|skip] [--no-graphify] [--ide claude] [--mode default]
coodra start | stop | status | doctor [--full]

# Features
coodra feature add <slug> [--description "..."]
coodra feature list
coodra feature show <slug>
coodra feature edit <slug>                     # opens $VISUAL/$EDITOR
coodra feature index                           # idempotent regen
coodra feature remove <slug> --force

# Templates / packs
coodra templates list
coodra templates install <name>                # interactive — type the confirmation phrase

# Database admin
coodra db migrate
coodra db backup [--out <path>]
coodra db restore <path>

# Policies
coodra policy list
coodra policy show <id>
```

### 5.2 Web routes (curl-able — all GET unless noted)

```
/                                                 dashboard
/projects                                         all projects
/projects/<slug>                                  project home
/projects/<slug>/features                         features list
/projects/<slug>/features/new                     create wizard (POST = Server Action)
/projects/<slug>/features/import                  import wizard (POST = Server Action)
/projects/<slug>/features/<fslug>                 feature detail
/projects/<slug>/features/<fslug>/files/<...path> render a supporting file
/projects/<slug>/features/<fslug>/edit            edit form (POST = Server Action)
/projects/<slug>/packs                            packs list (legacy)
/projects/<slug>/packs/new                        upload pack
/projects/<slug>/runs                             run history for this project
/projects/<slug>/runs/<runId>                     run detail (events, decisions, context-pack)
/packs                                            global pack catalog
/templates                                        starter templates
/policies                                         policy catalog
```

Server Actions are POSTed with an opaque `Next-Action` header — drive them
through the browser or by writing an actual form submission, not raw curl.

### 5.3 Bridge HTTP hooks

```
POST /v1/hooks/claude-code        Claude Code
POST /v1/hooks/cursor             Cursor (stdin/stdout adapter wraps this)
POST /v1/hooks/windsurf           Windsurf
GET  /healthz                     liveness — no auth
```

All hook POSTs require `X-Local-Hook-Secret: <hex>` from the project's `.env`.
Body matches Claude Code's hook contract — see
`code.claude.com/docs/en/hooks` for the field set. Minimum:

```json
{
  "session_id": "...",
  "hook_event_name": "SessionStart|PreToolUse|PostToolUse|Stop|SessionEnd|UserPromptSubmit",
  "transcript_path": "...",
  "cwd": "<absolute project path>",
  "source": "startup|subagent|..."
}
```

### 5.4 MCP tools (call via SDK Client over Streamable HTTP)

The single source of truth is `tools/list` — call it once and dump:

```javascript
const r = await client.listTools();
console.log(JSON.stringify(r.tools.map(t => ({name: t.name, desc: t.description.slice(0, 80)})), null, 2));
```

Tools you'll exercise during the test:

| Tool | When |
|---|---|
| `get_run_id` | Once at session start |
| `get_feature_pack` | If a project has a legacy pack; bridge auto-injects on SessionStart anyway |
| `list_features` | List skill-style features |
| `get_feature` | Load one feature's full body |
| `get_feature_file` | Load a supporting file from a feature |
| `query_run_history` | Find prior in-progress runs |
| `query_decisions` | "What did we decide about X?" |
| `search_packs_nl` | NL search over context packs |
| `record_decision` | At every design choice |
| `save_context_pack` | At session end (richer than the bridge's auto digest) |
| `check_policy` | Before every write/edit/delete/bash — Claude calls this; you verify it fired |
| `seed_feature_packs_from_graph` | Module 09 — when the agent calls it with a Leiden community payload, you see one draft `feature_packs` row per community + on-disk pack files under `docs/feature-packs/` |

---

## 6. Verification toolbox

### 6.1 Disk

```bash
# Features
ls docs/features/
cat docs/features/INDEX.md
cat docs/features/INDEX.json | python3 -m json.tool

# What's actually in a feature
cat docs/features/<slug>/feature.md
ls -R docs/features/<slug>/

# What did init write?
cat .coodra.json .env .mcp.json
```

### 6.2 SQLite

```bash
# Quick interactive
sqlite3 ~/.coodra/coodra.db

# In sqlite3:
.mode column
.headers on
.tables

# Useful one-shots:
sqlite3 ~/.coodra/coodra.db "SELECT slug, cwd FROM projects;"
sqlite3 ~/.coodra/coodra.db "SELECT id, status, created_at FROM runs ORDER BY created_at DESC LIMIT 5;"
sqlite3 ~/.coodra/coodra.db "SELECT description FROM decisions ORDER BY created_at DESC LIMIT 5;"
sqlite3 ~/.coodra/coodra.db "SELECT title, length(content) FROM context_packs ORDER BY created_at DESC LIMIT 5;"
sqlite3 ~/.coodra/coodra.db "SELECT tool_name, permission_decision, reason FROM policy_decisions ORDER BY created_at DESC LIMIT 10;"
sqlite3 ~/.coodra/coodra.db "SELECT name, COUNT(*) FROM policy_rules GROUP BY name;"
```

### 6.3 Bridge

```bash
# Probe SessionStart (substitute SECRET and PROJ)
SECRET=$(grep LOCAL_HOOK_SECRET $PROJ/.env | cut -d= -f2)
curl -sf -X POST http://127.0.0.1:3101/v1/hooks/claude-code \
  -H 'Content-Type: application/json' \
  -H "X-Local-Hook-Secret: $SECRET" \
  -d "{\"session_id\":\"probe-$RANDOM\",\"hook_event_name\":\"SessionStart\",\"transcript_path\":\"/tmp/t.jsonl\",\"cwd\":\"$PROJ\",\"source\":\"startup\"}" \
  -o /tmp/probe.json
python3 -m json.tool < /tmp/probe.json
```

### 6.4 MCP probe script (reusable)

Save as `~/mcp-probe.mjs`:

```javascript
import { Client } from '/Users/abishaikc/Coodra/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '/Users/abishaikc/Coodra/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';

const [tool, argsJson, cwd] = process.argv.slice(2);
const args = JSON.parse(argsJson || '{}');
const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3100/mcp'));
const client = new Client({ name: 'probe', version: '0.1' }, { capabilities: {} });
await client.connect(transport);
const res = await client.callTool({ name: tool, arguments: args, ...(cwd ? { _meta: { cwd } } : {}) });
console.log(JSON.stringify(res.structuredContent ?? res, null, 2));
await client.close();
```

Then:

```bash
# If "Server already initialized" — restart and try again.
node ~/mcp-probe.mjs list_features '{"projectSlug":"<slug>"}' "$PROJ"
node ~/mcp-probe.mjs get_feature '{"projectSlug":"<slug>","slug":"auth-flow"}' "$PROJ"
node ~/mcp-probe.mjs query_decisions '{"projectSlug":"<slug>","limit":5}' "$PROJ"
node ~/mcp-probe.mjs search_packs_nl '{"projectSlug":"<slug>","query":"auth"}' "$PROJ"
```

### 6.5 Logs

```bash
# Pretty-printed structured JSON
tail -F ~/.coodra/logs/mcp-server.log     | npx pino-pretty
tail -F ~/.coodra/logs/hooks-bridge.log   | npx pino-pretty

# Grep by correlation
grep '"sessionId":"<id>"' ~/.coodra/logs/hooks-bridge.log | npx pino-pretty
```

---

## 7. Observation protocol — what to write into `Coodra_functest/`

You write into the folder the user gave you. Suggested layout:

```
Coodra_functest/
├── 00-overview.md            written first; the chosen project + 6–10 planned features + session plan
├── 01-research.md            Phase 2 research notes
├── 02-setup.md               Phase 3 init artifacts + verification
├── 03-features.md            Phase 4 feature catalogue + the actual feature.md content for each (or links)
├── 04-build-slice-1.md       Phase 5 first Claude session
├── 04-build-slice-2.md       second slice — must answer the cross-session question (§5 Phase 5)
├── 04-build-slice-3.md       third slice
├── 04-build-slice-4.md       fourth slice (and beyond — one per session, no upper bound)
├── 05-stress.md              Phase 6 negative-path probes
├── 06-cross-session.md       a dedicated file analyzing how well context persisted across sessions
├── 99-report.md              Phase 7 final report (§10)
├── artifacts/
│   ├── INDEX-after-features.md       copy of docs/features/INDEX.md after Phase 4
│   ├── session-start-session-1.json  bridge response for the SessionStart of every session
│   ├── session-start-session-2.json
│   ├── session-start-session-N.json
│   ├── runs.csv                      sqlite dump after the build phase (full)
│   ├── decisions.csv
│   ├── context_packs.csv
│   ├── run_events.csv
│   └── policy_decisions.csv
└── screenshots/                       optional — the web UI for each phase
```

Every observation file follows this template:

```markdown
# <phase / slice title>

**When:** YYYY-MM-DD HH:MM
**Project:** <slug> at <abs path>
**Phase:** <number> — <name>

## What I tried
[bulleted list of commands / actions, in order]

## What I observed
[bulleted list — one bullet per surface: disk, DB, bridge, MCP, web, log]

## What surprised me
[bug-shaped things, contradictions between surfaces, slow paths, weird UX]

## What I'm carrying forward
[one-liner — what to remember for the next phase]

---

## Raw evidence
[paste the actual command output that backs the bullets above — keep it
verbatim and trimmed; the report is reproducible only if a future reader
can re-run the same commands]
```

**Frequency:** write *before* you forget. The right cadence is one
observation file per phase, not one giant log at the end. After every Claude
slice you finish — write. After every surprising failure — write.

---

## 8. Multi-terminal pattern

You will absolutely want at least 4 terminals open. Don't try this from one.

| Terminal | Purpose | Long-running command |
|---|---|---|
| **A — Claude Code** | The session driving the build | (run Claude Code itself in the project dir) |
| **B — bridge log tail** | Watch hooks fire in real time | `tail -F ~/.coodra/logs/hooks-bridge.log \| npx pino-pretty` |
| **C — MCP log tail** | Watch tool calls fire in real time | `tail -F ~/.coodra/logs/mcp-server.log \| npx pino-pretty` |
| **D — verification scratch** | curl probes, sqlite queries, MCP probes | (interactive) |
| **E — web app** | If you started it yourself | `pnpm --filter @coodra/web-v2 dev` |
| **F — observation writer** | Where you're editing files in `Coodra_functest/` | (your editor of choice) |

After each Claude slice finishes in **A**, switch to **D** and run the four
SQLite queries from §5.4. Watch **B** and **C** to see whether the bridge fed
context and the MCP wrote runs/decisions/context_packs at the right moments.

If you see a hook fire in **B** but no corresponding row in DB via **D**,
that's a real defect — capture it.

---

## 9. Failure protocol

When something doesn't work the way this guide says it should:

1. **Don't paper over it.** That's the whole point of the test.
2. **Capture three things into the relevant observation file:**
   - The command you ran (verbatim)
   - The output you got (verbatim)
   - The output you expected (referencing this guide's claim)
3. **Try one targeted recovery** — most often: restart services, clear the
   MCP "already initialized" state, or re-run with `pino-pretty` on logs.
4. **Continue the test.** A failure in Phase 4 doesn't block Phase 5 unless
   it's structural. Note it and keep going.
5. **At the end, escalate** — every captured failure goes in §10.4 of the
   final report.

Things that are NOT failures (don't waste capture budget on these):

- Web app spinning up on `:3001` instead of `:3000`. The user has another web
  app on `:3000`; Coodra web-v2 listens on `:3001` in dev.
- MCP server saying "already initialized" between two probe scripts. Documented
  quirk in §3.3.
- A feature add without `--description` warning about the TODO placeholder.
  That's the quality heuristic firing correctly.

---

## 10. Final report — `99-report.md`

```markdown
# Coodra Functional Test — Final Report

**Run:** YYYY-MM-DD by <agent / model name>
**Project:** <slug> at <abs path>
**Sessions:** <N> Claude Code sessions over <duration>
**Total elapsed wall-clock:** <hh:mm>

## 1. What I built
[one paragraph — the project's elevator pitch and what landed at the end.
Include: did it actually run? `pnpm test` passed? `curl /healthz` returned 200?]

## 2. Features I defined
[table — slug, one-line description, file count, how it was created
(CLI/wizard/import/hand-edit), whether the body was substantive or stub-y]

## 3. Multi-session persistence — THE headline finding
[This is the single most important section. Answer concretely:

- Did Session N open with awareness of what Sessions 1..N-1 did?
- For each session ≥2, what evidence was there of context carryover?
  (features Claude loaded unprompted, prior decisions referenced,
  conventions inherited)
- Was there any duplication of work across sessions?
- Did the agent ever ask you "what was decided about X" instead of querying
  Coodra?
- If you restarted MCP+bridge between sessions, did persistence still hold?

A score: 0 = Coodra doesn't persist, every session starts blank.
         5 = Coodra persists perfectly, sessions feel continuous.
         3 = mixed — context loaded but agent didn't always trust it.]

## 4. Surfaces exercised
| Surface | Calls | All passed? | Notes |
|---|---|---|---|
| CLI: feature add/list/show/edit/index/remove | n | yes/no | |
| Bridge: SessionStart / PreToolUse / PostToolUse / Stop / SessionEnd | n | yes/no | |
| MCP: list_features / get_feature / get_feature_file | n | yes/no | |
| MCP: record_decision / save_context_pack / query_decisions / search_packs_nl | n | yes/no | |
| MCP: check_policy / query_run_history | n | yes/no | |
| Web: /features /features/<fslug> /features/import /runs /packs | n | yes/no | |
| DB: projects / runs / run_events / decisions / context_packs / policy_decisions | n | yes/no | |

## 5. Soft-failure shape compliance
[For every soft-fail you triggered: did the response have ok:false + error +
howToFix? List any tool that didn't comply. This is the API contract for the
whole MCP surface — non-compliance is a real defect.]

## 6. Defects found
[one entry per real defect — what surface, what command, what failed,
severity (blocker / major / minor / cosmetic), and a proposed fix-direction.
Format:
  - **[severity] surface — short title**
    Reproduction: …
    Expected: …
    Actual: …
    Possible fix: …]

## 7. UX rough edges
[things that worked but felt wrong; if longer than 2 lines, promote to §6]

## 8. What Coodra does well
[because every test report needs a positive section. Be specific — not "it
works", but "the SessionStart auto-injection means I never had to remind
Claude about the project's conventions; it just knew."]

## 9. What I'd build next
[your three highest-leverage suggestions, ranked]

## 10. Confidence statement
[Would you give this tool to a teammate to use on a real project tomorrow?
Why / why not? One paragraph. Be honest — overstating confidence makes the
test worthless.]
```

---

## 11. Quick reference card (print this and stick it on the wall)

```
CLI                  alias coodra='node /Users/abishaikc/Coodra/packages/cli/dist/index.js'
Services up?         lsof -iTCP:3100 -sTCP:LISTEN -P; lsof -iTCP:3101 -sTCP:LISTEN -P
Bridge health        curl -sf http://127.0.0.1:3101/healthz
DB                   sqlite3 ~/.coodra/coodra.db
Logs                 tail -F ~/.coodra/logs/{mcp-server,hooks-bridge}.log | npx pino-pretty
Restart MCP          coodra stop && sleep 1 && coodra start
Web                  cd /Users/abishaikc/Coodra && pnpm --filter @coodra/web-v2 dev   # :3001
Project secret       SECRET=$(grep LOCAL_HOOK_SECRET <project>/.env | cut -d= -f2)
Bridge probe         curl -sf -X POST http://127.0.0.1:3101/v1/hooks/claude-code \
                       -H 'Content-Type: application/json' -H "X-Local-Hook-Secret: $SECRET" \
                       -d '{"session_id":"x","hook_event_name":"SessionStart",
                            "transcript_path":"/tmp/t","cwd":"<abs>","source":"startup"}'
MCP probe            node ~/mcp-probe.mjs <tool> '<args-json>' "<abs cwd>"
Features write paths CLI / web wizard / web import / hand-edit (all converge on disk)
Soft-fail shape      { ok:false, error:'<stable-code>', howToFix:'...' }
```

---

**You have everything you need.** Open six terminals, pick a boring big
project, define 6–10 accurate features (real bodies, not stubs), then run
**at least four separate Claude Code sessions** with deliberate gaps
between them. Write into `Coodra_functest/` as you observe — don't wait
until the end. The headline finding is whether Session 4 opens with full
awareness of what Sessions 1–3 did. That's the test. Ship the report.
