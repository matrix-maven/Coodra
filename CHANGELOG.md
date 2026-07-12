# Changelog

All notable changes to `@coodra/cli` are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Beta tags do not guarantee SemVer; breaking changes between `0.2.0-beta.x` releases are possible and called out per entry.

## [Unreleased]

## [0.2.0-beta.27] — 2026-07-12

Field-report remediation (MatrixOcr runs, Windsurf/Devin + Codex agents). Four defects fixed, each verified live against the built bundle; +60 unit tests.

### Added

- **`wiki_save_structure` replace guard.** Re-planning a wiki that already has ≥1 **authored** page now soft-fails with `wiki_exists` (returning the existing `wikiId` + authored/total counts) unless `replace: true` is passed. Previously the re-plan was an unconditional DELETE-then-INSERT, so two agents defaulting to the same project slug silently wiped each other's authored wikis — the root cause of "deep wiki generation seems inconsistent" in the 2026-07-12 field report. A pending-only skeleton still replaces freely, so same-session plan iteration is unaffected. The authoring recipe, trigger contract, and tool manifest document the new contract.
- **`coodra jira enable` detects a pre-existing Atlassian MCP server and asks before adding a second one.** Detection is by URL host (`mcp.atlassian.com`) across **every** `mcpServers`/`mcp_servers` entry — any key (`atlassian-mcp-server`, …), any shape (`url` / `serverUrl` / `npx mcp-remote` shim), including `disabled: true` variants. Interactive runs prompt (`[y/N]`); non-interactive/JSON runs skip with a notice; `--force` proceeds. `coodra init`'s Jira step skips-with-warning the same way, and `coodra jira status` now reports a foreign-keyed Atlassian server as "wired (not Coodra-managed)" instead of the misleading "no atlassian entry". (2026-07-12 field report: enable next to the user's existing `atlassian-mcp-server` produced two Atlassian servers.)

### Fixed

- **Windsurf sessions are no longer misattributed to Codex.** (2026-07-12 field report: a Windsurf/Devin session with `COODRA_AGENT_TYPE=windsurf` correctly stamped was recorded as `codex`.) Three-layer fix: (1) `get_run_id` now trusts the transport-resolved agent identity when it is known — the `agentType` input param only applies when the transport resolves `unknown`. The param is instruction-file text that any agent may parrot: AGENTS.md is a de-facto cross-agent standard, so Windsurf reading a Codex-generated AGENTS.md dutifully passed `agentType: "codex"` and it used to win. (2) On stdio, the per-config `COODRA_AGENT_TYPE` env stamp now takes precedence over the clientInfo-name heuristic (the stamp identifies the exact config entry that launched the server; HTTP keeps clientInfo-first). (3) The client-name mapping learned Windsurf's family names (`codeium`, `cascade`, `devin`) and the substring heuristics check `codex` **last** so it can't shadow other products. Instruction files now say "if you are a DIFFERENT agent reading this file, pass YOUR own type" instead of an unconditional `ALWAYS pass`.
- **`coodra uninstall` cleans the same project root `coodra init` wrote.** Uninstall used raw `process.cwd()`, while init resolves the project root by walking up to the nearest marker (`.git` / `package.json` / …) — so uninstall run from a subdirectory inspected a *different* `.cursor/mcp.json` (and `.mcp.json`, `.codex/config.toml`, `CLAUDE.md`, …) and reported "no coodra entry to remove" while the real entries persisted (2026-07-12 field report). Uninstall now resolves the root identically, prints it (`project root: …`), and includes it in `--json` output as `projectRoot`.
- **Deep-wiki coverage guidance no longer contradicts itself, and grounding no longer silently under-samples.** The authoring recipe's page-count guidance is mode-aware and repo-derived (comprehensive: one page per major module plus cross-cutting pages, typically 12–30, "when in doubt, ADD the page"; concise: 6–12), replacing the old "~8–20 pages" + "prefer fewer, deeper pages" contradiction that produced arbitrary low counts ("why only 11 pages?"). The grounding walk is now breadth-first (a truncated sample represents every top-level area instead of exhausting the cap inside the first alphabetical subtree), the file cap rose 600 → 1500, and a truncated list carries an explicit instruction to enumerate under-represented directories before planning.

## [0.2.0-beta.26] — 2026-07-09

### Added

- **`'ask'` policy tier — now enforced end-to-end.** A policy rule with `decision='ask'` (e.g. the seeded "ask before Bash" rule) propagates through the evaluator → `check_policy` → the hooks-bridge → Claude Code's `permissionDecision: 'ask'` (a real user-confirmation prompt). Previously the evaluator collapsed `'ask'` to `'allow'`, so the advertised confirmation tier silently did nothing. Cursor / Windsurf (no ask tier in their hook responses) degrade `'ask'` → `'allow'` at the serialization boundary. (E2E finding F6.)

### Changed

- **`packages/cli` publishes cleanly from a fresh clone.** `prepublishOnly` now runs a dependency-ordered workspace build (`scripts/build-for-publish.mjs`) before the bundle-integrity assert, so `pnpm install && cd packages/cli && npm publish` works from a pristine checkout (`dist/` is git-ignored). The build order pins web-v2 **before** the cli bundle — a bare `turbo run build` can't guarantee this because `cli ↔ web-v2` would be a dependency cycle. README + `packages/cli/README.md` document the flow and the `@coodra`-scope / rename note for publishing to another npm account.
- **`init` persists `LOCAL_HOOK_SECRET` to `$COODRA_HOME/.env`** so the daemons and every agent config share one secret (previously every `init` minted a fresh one → false drift on re-init and team-mode hook `401`s). (F1.)
- **`init` honours `HOOKS_BRIDGE_PORT` / `MCP_SERVER_PORT`** from the environment instead of hardcoding `3101` / `3100` into `.env` and the hook URLs. (F3.)
- **`init --team` warns and points at `coodra login`** when it can't resolve a team org, instead of silently registering the project as `__solo__` (which never syncs). (F9.)
- **Repository / homepage / bug URLs** now point at `github.com/matrix-maven/Coodra`.
- **Trigger-contract + `system-architecture.md` §24** use the real agent tool names (`Write` / `Edit` / `MultiEdit` / `NotebookEdit` / `Bash`) and the correct `sessionId` (not `runId`), so a doc-following agent's `check_policy` calls actually match the seeded rules. (F5 / F4.)

### Removed

- **`apps/web` (`@coodra/web`)** — the deprecated Module 04 web app, superseded by `apps/web-v2`. It was undepended-on, unshipped (the CLI bundles web-v2), absent from CI's build steps, and failed a clean build (13 cascading typecheck errors, masked locally by a persisted `dist/`). Its removal fixes `pnpm build` / the publish path on a cold checkout and drops ~140 files + 82 tests that only exercised dead code. web-v2 (44 routes, incl. its own Clerk sign-in) is the sole web surface.

### Fixed

- **Web sidebar no longer shows the maintainer's username (`abishaikc`) on every install.** `components/Sidebar.tsx` hardcoded `userName = 'abishaikc'` as a default prop, and `app/layout.tsx` never passed a real value — so every install's solo dashboard rendered the maintainer's name in the footer. The layout now resolves the serving machine's OS user at request time (`force-dynamic`, so it's never baked at build) and passes it through; the default fell back to a neutral `'local'`. A code-comment example that used the same name was genericized. (Build-machine absolute paths still appear in Next.js's internal manifests — not displayed to users; they reflect whoever builds the tarball, so a CI build makes them generic.)
- **`npm publish` runs on Windows** (with one documented caveat). Three Windows-specific breakages fixed: (1) `scripts/build-for-publish.mjs` spawned `pnpm` via `execFileSync('pnpm', …)`, which throws `ENOENT` on Windows (the shim is `pnpm.cmd`; `execFile` does no PATHEXT resolution) — fixed with `shell: true`; (2) the root `prepare` script used the POSIX `... 2>/dev/null || true` idiom that fails under Windows `cmd`, breaking `pnpm install` — replaced with a cross-platform Node one-liner; (3) apps/web-v2's Next.js `standalone` build doesn't complete reliably on Windows, so `build-for-publish.mjs` skips it there and `prepublish-assert.mjs` relaxes the web requirement to match. **Caveat: a tarball built on Windows omits the web dashboard** (`coodra start` runs headless on that install). A loud warning prints at build time. **Publish the official, complete package from macOS / Linux / CI**, where the web is built and the assert enforces it.
- **`policy_decisions` audit rows no longer collapse** when the caller omits a `toolUseId`: the idempotency key now includes a hash of the tool input, so distinct decisions (`.env` deny vs `src/app.ts` allow in one session) each get their own row. (F7.)
- **`sync-daemon` idempotently applies local SQLite migrations at boot**, so a daemon-first boot against a fresh `COODRA_HOME` no longer spins `no such table` until another service migrates. (F10.)
- **`COODRA_WINDSURF_CONFIG_PATH`** env override for the global Windsurf MCP config, mirroring `CLAUDE_SETTINGS_PATH` — scratch / CI runs no longer touch the operator's real `~/.codeium/windsurf/mcp_config.json`. (F2.)
- **Docs:** `save_context_pack` is documented as persisting to the Coodra store (DB), not to `docs/context-packs/` on disk. (F8.)

## [0.2.0-beta.9] — 2026-05-18

### Changed

- **`apps/web-v2/components/Topbar.tsx`** — the topbar "Docs" link now points at the published Coodra documentation site `https://abishai95141.github.io/Coodra/` instead of the upstream Claude Code repo placeholder (`https://github.com/anthropics/claude-code`) carried over from an earlier scaffolding pass. The link is constant across solo / team / team-hosted modes.

## [0.2.0-beta.8] — 2026-05-18

### Fixed

- **`packages/cli/src/commands/start.ts`** — `coodra start --tunnel` now re-installs the web service after the Cloudflare quick-tunnel URL is captured. Pre-fix flow: bootstrap all services (web's plist is generated with no `COODRA_PUBLIC_URL`) → start cloudflared → write `COODRA_PUBLIC_URL=<tunnel-url>` to `~/.coodra/.env`. The running web process never picked up the new env, so `resolveDeploymentBaseUrl()` inside the web process fell through to the `COODRA_HOME` local fallback (returning `http://localhost:3001`). Every URL the web rendered (invite tokens minted via `mintInviteAction`, JWT `iss` claims, `/install/<token>/cli.sh` body, `/api/install/<token>` issuer validation) used localhost instead of the tunnel URL. Result: cross-machine invite redemption failed with iss-mismatch even though the admin's tunnel was perfectly reachable. The fix is to capture the tunnel URL from `orchestrateTunnel` (signature now `Promise<string | null>`), then run `manager.stop('web') → manager.install(updatedUnit) → manager.start('web')` so the plist is regenerated with the fresh env. Cloudflared's target (loopback `:3001`) tolerates the ~2s outage transparently.

### Migration note for admins on beta.7

Users of beta.7 on `--tunnel` had to manually patch `~/Library/LaunchAgents/com.coodra.web.plist` to inject `COODRA_PUBLIC_URL`, then `launchctl bootout && bootstrap` web. On beta.8 the same `coodra start --tunnel` invocation produces a correct plist on first run; no manual patching needed.

## [0.2.0-beta.7] — 2026-05-18

### Fixed

- **`turbo.json`** — root cause of the beta.6 stale-bundle regression. The `build` task's `inputs` glob was hard-coded to `src/**/*.{ts,tsx}`. `apps/web-v2` (Next.js App Router) doesn't have a `src/` directory — its source lives in `app/`, `lib/`, `components/`, `middleware.ts`, and `next.config.ts`. None of those matched the glob, so Turbo's cache hash never changed for web-v2 source edits and it silently replayed an old build (in beta.6's case, a May-16 build from before the `public-url.ts` fix was even written). The bundle script then copied that stale `.next/standalone` into the CLI tarball. CI was green because unit tests run against source, not the bundle. Fixed by switching all task `inputs` to `$TURBO_DEFAULT$` (every tracked file in the package, the Turbo idiom for monorepos with mixed layouts) and adding `.next/**` to the `build` task's `outputs` so Turbo correctly tracks Next.js's standalone output too. The `apps/web-v2/lib/public-url.ts` fix that was authored in beta.6 is now actually present in the bundle.
- **`packages/cli/scripts/prepublish-assert.mjs`** — added a freshness check that walks `apps/web-v2/{lib,app,components,middleware.ts,next.config.ts}` for the newest source mtime and compares against `dist/runtime/web/apps/web-v2/server.js`. If source is newer than the bundle, the publish is refused with a clean-rebuild instruction. The Turbo fix above is the durable fix; this assert is the last-line defense against local-state divergence (e.g., a hand-rolled build that bypassed Turbo).

### Known issue (acknowledged)

- `@coodra/cli@0.2.0-beta.6` on the npm registry has the stale web bundle. Anyone installing `@coodra/cli@beta` between 2026-05-18 ~16:00 and the beta.7 publish will get the broken invite URL. **Mitigation for affected installs:** add `COODRA_PUBLIC_URL=http://localhost:3001` to `~/.coodra/.env`, then `coodra stop && coodra start`. That resolves via the existing `COODRA_PUBLIC_URL` env path (case 1), which has worked since beta.3. beta.7 ships the local fallback (case 3) bundled correctly so the env var is no longer required.

## [0.2.0-beta.6] — 2026-05-18

### Fixed

- **`apps/web-v2/lib/public-url.ts`**: when an admin runs `coodra start` on a laptop in team mode without ever setting `COODRA_PUBLIC_URL`, the invite URL emitted by `coodra invite` AND the web's `mintInviteAction` was `https://COODRA_PUBLIC_URL_NOT_SET.invalid/install/<token>` — the sentinel was baked into BOTH the URL host AND the JWT `iss` claim, making the link completely unusable. The resolver had cases for `COODRA_PUBLIC_URL` (explicit override) → `VERCEL_URL` (auto-set on Vercel) → sentinel, but no fallback for local CLI invocation. Added case 3: when `COODRA_HOME` is set (a strong signal that the web standalone was launched by `@coodra/cli`'s daemon manager on a developer laptop), resolve to `http://localhost:${PORT ?? 3001}`. The sentinel still fires for cloud deployments that legitimately forgot `COODRA_PUBLIC_URL` — only laptop installs are affected. `isDeploymentBaseUrlUnset()` continues to return `false` for the new local fallback so no remediation banner is shown for valid laptop URLs.
- New unit test file `apps/web-v2/__tests__/unit/lib/public-url.test.ts` covers all four resolver cases plus the `isDeploymentBaseUrlUnset` invariants.

## [0.2.0-beta.5] — 2026-05-18

### Fixed

- **`packages/cli/src/lib/services.ts`**: web service plist now emits `HOSTNAME=::` (IPv6 wildcard, dual-stack) instead of `HOSTNAME=127.0.0.1`. beta.4's narrower `127.0.0.1` bind made the CLI's IPv4 healthcheck land, but broke team-mode `force-dynamic` routes: Next.js 15.5 standalone has an internal render-proxy (`next/dist/server/lib/router-utils/proxy-request.js`) that does a server-side `fetch('http://localhost:${PORT}/<route>')` to itself for force-dynamic routes. macOS resolves `localhost` to `::1` first; with an IPv4-only bind the self-proxy had no listener; requests hung; `/api/healthz` (which has `export const dynamic = 'force-dynamic'`) never returned; `coodra start` again reported "Coodra Web did not become healthy on :3001 within 30000ms" even though Next was running. `::` with the kernel-default `IPV6_V6ONLY=0` accepts both native IPv6 (`::1`) AND IPv4 connections (via IPv4-mapped IPv6), so the Next self-proxy AND the CLI's IPv4 healthcheck both land cleanly. Cold start to first 200 on `/api/healthz` is ~2 seconds on a developer laptop.
- The regression-locking test in `packages/cli/__tests__/unit/services.test.ts` is updated to assert `HOSTNAME=::`. The test docstring records the full beta.3 → beta.4 → beta.5 regression history so a future refactor can't silently re-introduce either prior failure.

### Known trade-off

- **Web is now LAN-reachable** (not loopback-only) because `::` listens on all IPv6 interfaces (and IPv4-mapped IPv6 is accepted by default on macOS/Linux). In team mode every route is gated behind Clerk auth, so a LAN attacker still needs a valid session — but solo-mode users on hostile networks should add a local firewall rule. A loopback-only dual-stack bind (separate `listen()` calls on `127.0.0.1` and `::1`) is tracked as a follow-up but requires wrapping Next.js's auto-generated `server.js`; not in this release.

## [0.2.0-beta.4] — 2026-05-18

### Fixed

- **`packages/cli/src/lib/services.ts`**: web service plist now emits `HOSTNAME=127.0.0.1` instead of `localhost`. macOS getaddrinfo (and recent glibc variants) resolves `localhost` IPv6-first, so Next.js 15.5 bound only `::1:3001`. The CLI's IPv4 healthcheck (and doctor check #37) probes `http://127.0.0.1:3001/api/healthz`, which got ECONNREFUSED against the IPv6-only listener — `coodra start` then reported `Coodra Web did not become healthy on :3001 within 30000ms` even though Next was running cleanly. Anchoring to the IPv4 literal removes the resolver dependency. Team-mode admins who set a custom `COODRA_PUBLIC_URL` should use `http://127.0.0.1:3001` (matching the bind) or a tunnel URL — the previous fix widened the bind to compensate for a `localhost` public URL and reintroduced the healthcheck regression.
- New regression test `resolveServices — web service env (2026-05-18 regression)` in `packages/cli/__tests__/unit/services.test.ts` locks `HOSTNAME=127.0.0.1` so a future refactor can't silently flip it back to `localhost`.

### Changed

- **README**: rewrote as an immersive GitHub landing surface — bold motto, mermaid system + session-lifecycle diagrams, three-pillar pitch, solo/team comparison, verified 16-tool MCP inventory.
- **CI**: verify job builds workspace packages in dependency order (shared → db → policy → cli tsc-only → mcp-server → hooks-bridge → web-v2 → cli full) so a clean checkout produces every dist artifact downstream tests need.
- **CI**: integration job serialized across workspaces (`turbo run test:integration --concurrency=1`) because each workspace's `beforeAll` drops + re-migrates the shared CI Postgres.

### Added

- `.github/ISSUE_TEMPLATE/{bug_report,feature_request}.yml` — structured issue forms. Bug template requires `coodra doctor --json` + version + mode + agent + OS + Node for low-friction triage.
- `.github/ISSUE_TEMPLATE/config.yml` — disables blank issues; points "Security" + "Architecture question" at the right places.
- `.github/PULL_REQUEST_TEMPLATE.md` — short checklist mirroring CONTRIBUTING.md's "done" criteria.
- `SECURITY.md` — supported-versions table, scope, private disclosure channel.
- `CODE_OF_CONDUCT.md` — adapted from Contributor Covenant 2.1.
- `CHANGELOG.md` — this file.
- `packages/cli/scripts/prepublish-assert.mjs` — refuses `npm publish` when `dist/runtime/{web,mcp-server,hooks-bridge,sync-daemon}` artifacts are missing, with a remediation message naming the exact fix.

### Fixed (infra carried from prior unreleased work)

- **`apps/web/package.json`**: declares `@coodra/cli` as a workspace dep so Turbo schedules `@coodra/cli:build` before `@coodra/web:typecheck` on clean CI checkouts. Previously the deprecated `apps/web` typecheck failed on CI with 13 cascading errors (module-not-found + implicit `any`); locally it passed because `dist/` persisted from prior builds.
- **`packages/cli/scripts/bundle.mjs`**: soft-skips the web standalone copy when `apps/web-v2/.next/standalone` is missing (typical for CI typecheck-only flows where web-v2 hasn't been built yet). Strict mode opt-in via `COODRA_BUNDLE_REQUIRE_WEB=1`. Publish-time is guarded by the new `prepublishOnly` assert.

### Known issues (tracked)

- [#1](https://github.com/Abishai95141/Coodra/issues/1) — integration job has 8 latent test failures unrelated to user-facing functionality. CLI works for users; tests need triage.

## [0.2.0-beta.3] — 2026-05-15

First public-beta tag of `@coodra/cli` on npm.

### Added

- Full CLI surface: `init`, `start`, `stop`, `status`, `agents`, `login`, `logout`, `invite`, `doctor`, `org {status,switch}`, `db {migrate,backup,restore}`, `policy {list,show,add,enable,disable}`, `project {list,show,reset,promote,demote}`, `run {list,show,cancel}`, `pack {new,list,show,regenerate,delete}`, `feature {add,list,show,edit,index,remove}`, `template {list,install}`, `team {login,logout,migrate,join,leave,init,setup,install}`, `export`, `upgrade`, `uninstall`, `logs`, `pause`, `resume`, `ui`.
- 38-check health-report registry (`coodra doctor --full`); 11 essentials by default.
- Single-tarball install via esbuild; bundles MCP Server + Hooks Bridge + Sync Daemon + Web v2 dashboard inside `dist/runtime/`.

### Architectural milestones folded into this beta

- **Phase F** — knowledge-layer cloud sync (features + feature_packs with conflict sidecars).
- **Phase G** — unified Clerk identity, browser-handoff login, multi-org plumbing.
- **Phase H** — seamless team onboarding via `coodra invite <email>` (HMAC-signed install URLs).
- **ADR-012** — bridge-mediated autonomous coordination (Feature Pack injection + Context Pack auto-save fire from the hooks bridge, no agent cooperation required).
- **ADR-013** — Run Diff replaces the planned Python Semantic Diff service; in-process `git diff` runner with structured records.
- **ADR-014** — Tier 2.5 RBAC (admin / member / viewer Clerk roles); local-only hooks bridge in both modes.

[Unreleased]: https://github.com/Abishai95141/Coodra/compare/HEAD...HEAD
[0.2.0-beta.3]: https://github.com/Abishai95141/Coodra/releases/tag/v0.2.0-beta.3
