# Changelog

All notable changes to `@coodra/cli` are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Beta tags do not guarantee SemVer; breaking changes between `0.2.0-beta.x` releases are possible and called out per entry.

## [Unreleased]

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

### Fixed

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
