# 08 — Implementation Order & Context Pack Protocol

## 8.1 Module build order

Modules MUST be implemented in order. Each depends on the previous ones.

| Module | Name | Depends On | Feature Pack Spec |
|--------|------|-----------|-------------------|
| 01 | Foundation | — | `docs/feature-packs/01-foundation/` |
| 02 | MCP Server (incl. tool manifest per `system-architecture.md` §24) | 01 | `docs/feature-packs/02-mcp-server/` |
| 03 | Hooks Bridge | 01, 02 | `docs/feature-packs/03-hooks-bridge/` |
| 08a | CLI (`@coodra/cli`) — install + lifecycle | 01, 02, 03 | `docs/feature-packs/08a-cli/` |
| 04 | Web App | 01, 02, 08a | `docs/feature-packs/04-web-app/` |
| 05 | NL Assembly | 01, 02 | `docs/feature-packs/05-nl-assembly/` |
| 06 | Semantic Diff | 01, 03 | `docs/feature-packs/06-semantic-diff/` |
| 07 | VS Code Extension | 02, 03, 04, 08a | `docs/feature-packs/07-vscode-extension/` |

**Why Module 08a is numbered 08a, not 08:** the original "Module 08 Distribution" plan included a marketing site, npm publish automation, and an Anthropic MCP marketplace listing. Per the user directive 2026-04-24, marketing and distribution-channel work is **out of scope** for this project — only the CLI portion remains, hence the `08a` suffix. There is no Module 08b. Future channel work (marketing site, npm publish flag day, marketplace submission) is tracked in `context_memory/pending-user-actions.md` as user-side ops, not in the module sequence.

**Why Module 08a lands between 03 and 04, not at the end:** the Web App (Module 04) onboarding flow assumes a working `coodra init` command exists. The VS Code Extension (Module 07) shells out to `coodra start` / `stop` / `status` for service control. Both modules need 08a to land first or they end up reimplementing daemon-management surfaces.

**Scope items deliberately out of every module spec:**

- **No billing, Stripe, seat management, or usage metering** in any module. Per user directive 2026-04-24 — "forget about monetary setup, only focus on building the working product." Module 04 is admin / dashboard / team management only.
- **No marketing site, no `coodra.dev` HTML, no landing page.** Per user directive 2026-04-24 — "we are not making the landing page here, only the system."
- **No BYO-cloud team deploy.** Team mode is hosted by us (single managed Postgres + Upstash + Railway/Fly.io stack). BYO-cloud Enterprise variant is post-launch.
- **Managed LLM in team mode is Gemini, not Anthropic.** Per user directive 2026-04-24. Solo mode continues to support Ollama (local) as the default. Module 05's NL Assembly tier-2 selection logic uses `GEMINI_API_KEY` first; the `ANTHROPIC_API_KEY` branch can be removed when Module 05 ships.

## 8.2 Before starting a module

1. Read `spec.md` — understand what you are building and why.
2. Read `implementation.md` — follow the step-by-step plan.
3. Read `techstack.md` — understand the technology choices.
4. Read `docs/research/research_answers.md` — verified API details for Drizzle, pgvector, Supabase, sentence-transformers, tree-sitter, FastAPI, Anthropic SDK, BullMQ, testcontainers, Biome, Turborepo.
5. Read `docs/DEVELOPMENT.md` — local dev setup, service commands, test commands, troubleshooting.

## 8.3 What "complete" means for a module

- All code written and compiling (`pnpm typecheck` passes).
- All tests written and passing (`pnpm test:unit` and `pnpm test:integration`).
- Linting passes (`pnpm lint`).
- Integration with previous modules verified manually.
- Context Pack saved to `docs/context-packs/`.

## 8.4 Context Pack Protocol

After completing any module or significant feature, you MUST save a Context Pack. This is how knowledge transfers between AI agent sessions.

**Save to:** `docs/context-packs/YYYY-MM-DD-module-name.md`

**Template:** `docs/context-packs/template.md`

**What to include:**

- What was built (specific files, functions, endpoints).
- Decisions made (why X instead of Y, with rationale).
- Files created or modified (complete list).
- Tests written (what they cover).
- How integration was verified.
- Known issues or limitations.
- What should be built next.

**How to save it:** call `coodra__save_context_pack` (see `05-agent-trigger-contract.md` §5.9). That call writes the pack to `docs/context-packs/` AND registers it in the MCP store, so future `coodra__search_packs_nl` calls can find it.

**This is not optional.** Context Packs are the memory of the project. Without them, the next agent session starts from zero.
