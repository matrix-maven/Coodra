# Manual Verification Harnesses

These scripts are runnable one-shots, not vitest targets. Most are historical
verification aids from earlier Coodra modules; prefer current unit,
integration, functional, and CI smoke suites for launch validation.

Coodra source and test materials are licensed under Apache-2.0.

Harnesses run against built output. Run `pnpm build` first if source changed.

| Harness | Run with | What it covers |
|---|---|---|
| `verify.ts` | `pnpm exec tsx __tests__/manual/verify.ts` | Historical M01+M02 stdio walk. |
| `verify-m1-m3.ts` | `pnpm exec tsx __tests__/manual/verify-m1-m3.ts` | Historical bridge-era walk. |
| `verify-save-pack.ts` | `pnpm exec tsx __tests__/manual/verify-save-pack.ts` | Spawns a fresh stdio MCP subprocess and saves a context pack. |
| `verify-sigterm-drain.ts` | `pnpm exec tsx __tests__/manual/verify-sigterm-drain.ts` | Graceful-shutdown drain check for async policy/audit writes. |
| `verify-outbox-crash-safety.ts` | See file header. | Historical bridge-era crash-safety check. |
| `verify-sync-roundtrip.ts` | `DATABASE_URL=postgres://... pnpm exec tsx __tests__/manual/verify-sync-roundtrip.ts` | Historical bridge-era team-sync roundtrip. Requires a cloud Postgres reachable via `DATABASE_URL` and `psql` on PATH. |
| `verify-f5-live.ts` | `pnpm exec tsx __tests__/manual/verify-f5-live.ts` | Live boundary check for `check_policy` session id validation. |
| `verify-phase5-loop.ts` | See file header. | Historical bridge-era closed-loop test. |
| `verify-phase5-closed-loop.ts` | `LOCAL_HOOK_SECRET=<hex> pnpm exec tsx __tests__/manual/verify-phase5-closed-loop.ts` | Historical bridge-era closed-loop test. |
| `_drain.mjs`, `_migrate.mjs` | Sourced by other harnesses. | Internal helpers. |

Standing rule: harnesses talk to built output. If you change source, build
first or you may be testing stale code.
