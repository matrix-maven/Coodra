# references/architecture-map.md

Pointer guide into `../../system-architecture.md` (25 sections, §0–§24). Use this to jump directly to the section you need without scanning the whole file.

## When to open which section

| Question you have | Go to |
|---|---|
| Why is the architecture shaped this way, vs. the first AI-generated plan? | §0 Corrections to the AI-Generated Plan |
| Solo mode vs. team mode — what changes where? | §1 Two-Mode Architecture |
| Which services exist and which languages / ports are they on? | §2 Service Inventory |
| JSON wire formats, hook payloads, MCP transport, SSE, cloud sync REST | §3 Data in Motion |
| Schemas: SQLite (solo) and Postgres + pgvector (team) | §4 Data at Rest |
| CAP per service boundary — when we pick AP vs CP | §5 CAP Theorem — Per-Service Analysis |
| SLA / SLO targets per mode | §6 Availability, SLA, SLO |
| Fail-open invariants, circuit breakers, timeouts | §7 Fault Tolerance |
| Throughput / latency budgets | §8 Throughput and Latency |
| Networking, loopback vs TLS, inbound vs outbound | §9 Networking and Transport Layer |
| URL routing, API versioning, deprecation policy, MCP tool stability | §10 API Design, Versioning, and Backward Compatibility |
| CORS policy, per mode | §11 CORS Configuration |
| Browser / CDN / server-side caching layers | §12 Caching — All Three Layers |
| `coodra start`, Docker Compose, production infra shape | §13 Server Setup and Infrastructure |
| Why SQLite for solo and Postgres for team | §14 Database Selection Rationale |
| Scaling strategy — solo (vertical) and team (horizontal) | §15 Scaling Strategy |
| Cross-cutting patterns (19 currently) — circuit breakers, idempotency, hooks, outbound integrations, inbound webhooks, Repository Graph Index, tool descriptions as agent prompts | §16 Design Patterns |
| Graphify import flow for cold-start Feature Packs | §17 Graphify Integration |
| NL Assembly LLM enrichment strategy — two-tier Ollama/Anthropic/Gemini | §18 LLM Enrichment Strategy |
| Clerk JWT auth, solo-mode no-auth bypass, NHI scoping | §19 Auth Strategy |
| CI/CD pipeline jobs and ordering | §20 CI/CD Pipeline |
| Design decisions still open / unlocked | §21 Open Decisions |
| JIRA integration — auth, data model, 8 MCP tools, webhook ingress, ADF conversion, NL Assembly input, Context Pack → JIRA comment, CAP, fail-open | §22 Issue Tracker (JIRA / Atlassian) Integration |
| GitHub integration — App vs PAT auth, Repository Graph Index, CODEOWNERS & branch protection as policy inputs, 10 MCP tools, webhook ingress, NL Assembly input, Context Pack → PR comment, rate limits, fail-open | §23 GitHub Governance & Context Layer |
| MCP tool manifest, `tools/list` handshake, description anatomy, trigger taxonomy, sync-with-reality safeguards | §24 MCP Tool Manifest & Agent Discovery Contract |

## Section-to-file quick reference

Most Coodra-level rules in `essentialsforclaude/` are concise summaries of one or more architecture sections. When you need depth, this map tells you which architecture section a rule ultimately traces back to:

| essentialsforclaude file | Draws depth from |
|---|---|
| `00-identity.md` | §1, §2, §13 |
| `01-development-discipline.md` | §7 (fail-open), §16 (patterns) |
| `02-agent-human-boundary.md` | §19 (auth), §22.3 / §23.7 (integration install flows) |
| `03-context-memory.md` | Distinct from architecture — ephemeral working memory, not covered in the big doc |
| `04-when-in-doubt.md` | §21 (open decisions is the standing "ask the user" catalogue) |
| `05-agent-trigger-contract.md` | §24 (full manifest), §22.4 (JIRA tools), §23.6 (GitHub tools) |
| `06-testing.md` | §20 (CI), §24.9 (manifest test) |
| `07-style-and-conventions.md` | §20 |
| `08-implementation-order.md` | §2 (modules), §16 (patterns) |
| `09-common-patterns.md` | §3.5 (MCP transport), §16 (all patterns), §24.7 (manifest.ts location) |
| `10-troubleshooting.md` | Local-dev only; see `docs/DEVELOPMENT.md` for more |
| `11-adrs.md` | §14 (DB), §19 (auth), §16 (patterns), §17 (Graphify) |
