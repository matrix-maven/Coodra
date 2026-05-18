# Changelog

All notable changes to `@coodra/cli` are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Beta tags do not guarantee SemVer; breaking changes between `0.2.0-beta.x` releases are possible and called out per entry.

## [Unreleased]

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
