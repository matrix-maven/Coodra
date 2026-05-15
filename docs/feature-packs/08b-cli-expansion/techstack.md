# Module 08b — CLI Expansion — Tech Stack

> Read `spec.md` and `implementation.md` first. M08b extends `@coodra/cli` — every dep already pinned in `docs/feature-packs/08a-cli/techstack.md` is reused unchanged. This file lists ONLY the new pins M08b adds, plus the reasons each is justified vs. the alternatives.

> Pinned versions here MUST match `External api and library reference.md`. Any version bump is amendment-B (same-commit doc edit).

> **`External api and library reference.md` updates land per-slice, not here.** The reference's entry-style — multi-paragraph treatment with verified code snippets and gotchas — only earns its place once the dep has been used in practice. Each slice that introduces a new dep amends the reference in the same commit; this file declares intent.

## Runtime

No change from M08a:

| Choice | Pin | Rationale |
|---|---|---|
| Node.js | ≥22.16.0 | Repo standard. |
| Module system | ESM | Matches every other CLI module. |
| TypeScript | `^6.0.3` | Repo standard. |

## New direct dependencies (production)

M08b keeps the production-dep surface as small as M08a's. Three new pins, each justified below.

| Library | Pin | Slice | Why this one |
|---|---|---|---|
| `tar` | `^7.4.3` | S6 (db backup --include-logs) | Native node-tar from npm — pure JS, used by `npm` itself. Streams gzip + tar without spawning the system `tar` binary (Windows portability). **Considered alternative: spawn `tar` via `execa`** — works on macOS/Linux but `tar` on Windows has different flags + .tar.gz handling quirks. **Considered alternative: `archiver`** — feature-equivalent but ~3× the install size. node-tar wins on size + Windows parity. Used only in S6's `--include-logs` path; default backup format (single-file `VACUUM INTO`) needs no archive lib at all. |
| `semver` | `^7.6.3` | S7 (upgrade) | Single-purpose, ~30 KB. Used to compare installed version vs `npm view` published version. Drizzle, npm, ts-node, vite all depend on it transitively — already present in the lockfile. **Considered alternative: hand-rolled `parseInt` split** — fragile on pre-release tags (`-beta`, `-rc`, `-canary`) which the npm registry returns. semver handles this correctly. |
| `fast-check` | `^3.23.2` | S14 (auto-marker parser tests, dev-only) | Property-based test framework. Used for the parser's roundtrip property `serialize(parse(x)) === x` per implementation.md S14. **DevDependency only** — never ships in the npm tarball. |

## New indirect dependencies (none)

No new transitive deps introduced beyond what `tar`, `semver`, `fast-check` already pull in (already vetted by being npm-popular packages).

## Out-of-scope libraries (deliberately NOT added)

These were considered and rejected:

- **`mustache` / `handlebars` / `eta` / `ejs`** — for template rendering (S13). Templates use only `{{slug}}`, `{{date}}`, `{{detectedLanguages}}`, `{{detectedDeps}}` substitutions. Hand-rolled `String.prototype.replace` covers it in ~20 lines and ships zero deps. A real template engine becomes warranted only when conditional logic (`{{#if has-postgres}}...{{/if}}`) lands; defer until the use case appears.
- **`commander-prompts` / `inquirer` / `prompts`** — for interactive confirmations (S6 restore, S8 uninstall, S10 project reset, S16 pack delete). M08a §11 Decision 3 already locked `prompts` out for `init`. M08b inherits the stance: `--force` flag for destructive ops, no interactive prompts. Keeps `--json` mode + non-TTY pipelines working.
- **`chokidar`** — for `coodra logs --follow` (S4). Node's built-in `fs.watch` is sufficient for the single-file watch scenario; chokidar's cross-platform fix-ups matter when watching many files in many directories, which logs-tail isn't.
- **`uuid`** — every M08b slice that mints an id uses Node's built-in `crypto.randomUUID()` (already used by `ensureDefaultPolicy`).
- **`yaml` / `js-yaml`** — `template.json` is JSON, not YAML. Switching would be a one-time choice; sticking with JSON keeps zero new deps.
- **`marked` / `markdown-it` / `remark`** — for HTML export (S12 render-html). The renderer wraps the markdown output in a static HTML document with a fenced `<pre>` block + minimal CSS for monospace + line wrap. Not parsing markdown into structured HTML — full markdown→HTML conversion is overkill for the operator-readable export.
- **`@slack/webhook` / `@slack/web-api`** — for `export --webhook` (S12). The Slack incoming-webhook wire format is a JSON POST with a single `text` or `blocks` field; built-in `fetch` is sufficient. The Slack SDKs add OAuth + retry + bot-user features none of which M08b needs.
- **`pg-dump-style` Postgres backup helpers** — `db backup` is SQLite-only. The Postgres-mode backup story is owned by Supabase / managed Postgres / the user's cloud provider, NOT by the CLI. Out of M08b scope.

## Updated process exit codes

M08a defined codes 0–4 + 99. M08b adds two and reserves three:

| Code | M08a meaning | M08b extension |
|---|---|---|
| 0 | Success / no-op | unchanged |
| 1 | User-recoverable failure | unchanged |
| 2 | User-action required | unchanged |
| 3 | Environment problem | unchanged |
| 4 | Service-startup failure | unchanged |
| **5** | (reserved) | **NEW — Kill-switch refusal.** `pause` returns 5 when the requested scope is already paused (still idempotent — returns the existing switch id). |
| **6** | (reserved) | **NEW — Backup/restore precondition unmet.** `db backup` returns 6 on disk-full or repeated `SQLITE_BUSY`; `db restore` returns 6 if the auto-backup-of-current step fails. |
| 7–9 | (reserved) | reserved for follow-up modules |
| 99 | Unimplemented | unchanged |

These codes MUST stay stable across versions — shell scripts on user machines depend on them. Adding a new code is non-breaking; reusing or removing a code is a major version bump (same posture as M08a).

## Distribution

| Channel | Status in M08b |
|---|---|
| `npm` (scope: `@coodra`, package: `@coodra/cli`) | Same. M08b adds `dist/templates/**` to the published tarball — file-list test from M08a S9 expands to assert templates present. **Not published in M08b.** Publish-flag-day remains a separate ops task. |
| Anthropic MCP marketplace | Unchanged from M08a posture. |
| Homebrew tap / Scoop bucket / `apt` | Not in scope. |

## Templates — bundling mechanics

`packages/cli/scripts/bundle.mjs` (introduced in M08a Phase 2) currently runs esbuild against `src/index.ts` with `runtime/**` co-shipped via `cp -R`. M08b extends the script:

```
dist/
├── index.js                  (esbuild bundle of src/**)
├── runtime/                  (copy of M08a's runtime/* — mcp-server, hooks-bridge, drizzle/)
└── templates/                (NEW — copy of packages/cli/templates/**)
    ├── generic/
    │   ├── template.json
    │   ├── spec.md.tmpl
    │   ├── implementation.md.tmpl
    │   ├── techstack.md.tmpl
    │   └── meta.json.tmpl
    ├── node-monorepo/...
    └── ... (5 more)
```

The runtime resolver `lib/template-paths.ts` (S13) resolves a template name to its on-disk directory in this order:

1. `~/.coodra/templates/<name>/` (user-installed)
2. `<cli-dist>/templates/<name>/` (bundled, npm-installed)
3. `<workspace-root>/packages/cli/templates/<name>/` (monorepo dev fallback — same pattern as `runtime-paths.ts`)

If none resolve → throw a structured `Error` with `code: 'COODRA_TEMPLATE_NOT_FOUND'` (extends M08a's resolver-error pattern).

## Auto-marker parser — performance posture

The parser (S14) is a **single-pass O(n) string scan** that respects fenced code blocks. No regex catastrophic-backtracking risk because the only regex is the open-tag pattern `/^<!-- @auto:([a-z0-9][a-z0-9-]{0,63}) -->\s*$/m` (anchored both ends, bounded length).

Memory: linear in the file size. The largest expected feature-pack file is ~50 KB; parsing is sub-millisecond. The roundtrip property test (S14) bounds input to ~10 KB to keep `fast-check` runtime reasonable.

## Gotchas

- **`VACUUM INTO` requires `journal_mode != 'delete'`** — the `@coodra/db::createDb({ kind: 'local' })` factory already sets `journal_mode = WAL`, so this is satisfied. Tests in S6 run against the same factory to avoid drift.
- **`npm view --json` returns the full registry document, not just the version.** S7's helper queries with `--json` then parses; if registry returns plain text (older npm), the helper fails fast with a remediation pointing at npm version.
- **`tar` (node) emits a `'finish'` event before all bytes hit disk on some platforms.** Use the `pipeline()` helper from `node:stream/promises` to await the actual flush.
- **`fs.watch` (used by `logs --follow`) emits one event per filesystem change on macOS but coalesces on Linux.** S4's reader buffers events and reads-to-EOF on every wake; tests use a synthetic file-write loop to assert no lines are missed.
- **`semver.gt('1.0.0', '1.0.0-beta.1')` returns `true`** — the released version dominates pre-releases, so a user on `1.0.0-beta.1` sees `1.0.0` as an upgrade. This is the npm-conventional behaviour and is correct for `coodra upgrade`.
- **Atomic file writes on Windows: `fs.rename` requires the destination to be on the same volume.** `db restore` writes the temp file next to the destination (same dir as `data.db`), not to `os.tmpdir()`, to keep the rename atomic. Same posture as M08a's `claude-settings-merge.ts`.
- **`~/.coodra/templates/` symlinks** — `template install` resolves the source path with `fs.realpath` before copying to avoid following a symlink that escapes the user's intended template directory. Pure copy, never `mklink` / `ln -s`.
- **kill-switch cache TTL is 5 seconds, not 60.** Operator pause/resume should feel near-instant. The 60-second policy cache TTL trades freshness for read latency; kill-switch reads are rarer (one switch per minute is "a lot") so a 5s TTL costs ~12 DB queries per minute per bridge, which is negligible.
