# Goal W1 — Web bundles into CLI; isolated install boots web on :3001

> Paste the block below (between the `---` markers) into Claude Code after
> compact:
>
>     /goal <PASTE THE CONDITION>

---

Web Bundle slice W1. Bundle apps/web-v2 (Next.js) into the CLI tarball alongside the existing mcp-server / hooks-bridge / sync-daemon runtime bundles, so a fresh `npm i @coodra/cli` on any machine with Node ≥22 gets the dashboard at http://localhost:3001/ on `coodra start`. The Web Bundle Initiative master plan lives at /Users/abishaikc/Coodra/web-bundle-plan.md. Load it first.

Implementation:
1. `apps/web-v2/next.config.ts` → `output: 'standalone'`. Keep the existing `loadCoodraHomeEnv()` shim. Run `pnpm --filter @coodra/web-v2 build` to confirm the standalone trace produces `.next/standalone/`, `.next/static/`, and that `better-sqlite3` + `sqlite-vec` native bindings survive (Next.js's serverComponentsExternalPackages may need them listed).
2. `packages/cli/scripts/bundle.mjs` — after the 4 existing esbuild calls, copy `apps/web-v2/.next/standalone/` + `.next/static/` + `public/` into `packages/cli/dist/runtime/web/`. The Next.js standalone entry is `node .next/standalone/server.js`; preserve directory structure.
3. `packages/cli/src/lib/services.ts` — register a 5th service descriptor: name='web', kind='http', port=3001, healthUrl=`http://127.0.0.1:3001/api/healthz`, spawn=`node <runtime/web/server.js path resolved via resolveRuntimeBinary>`. Set `HOSTNAME=127.0.0.1` and `PORT=3001` in spawn env.
4. `packages/cli/src/lib/runtime-paths.ts` — add 'web' to the resolveRuntimeBinary union.
5. `coodra start` — no code change; the iterator picks up the new service.
6. Doctor check 30 (new) — verify GET /api/healthz on :3001 returns 200 in team mode AND solo mode.

Acceptance (paste verbatim outputs for each step):
(A) `pnpm --filter @coodra/web-v2 build` succeeds; `ls apps/web-v2/.next/standalone/server.js` exists.
(B) `pnpm --filter @coodra/cli build` succeeds; `ls packages/cli/dist/runtime/web/server.js` exists; `tar -tzf <pnpm pack output> | grep '^package/dist/runtime/web/.next/' | wc -l` returns ≥ 50.
(C) `pnpm -r typecheck` clean; `pnpm -r test:unit` reports 1048+ tests pass (no regressions).
(D) Isolated install in fresh /tmp/h-w1-iso/: `mkdir /tmp/h-w1-iso && cd /tmp/h-w1-iso && echo '{}' > package.json && npm i --no-package-lock <path-to-tgz>`. Then in a fresh /tmp/h-w1-proj/: `git init -q . && echo '{}' > package.json && COODRA_HOME=/tmp/h-w1-home /tmp/h-w1-iso/node_modules/.bin/coodra init` exits 0. Then `COODRA_HOME=/tmp/h-w1-home /tmp/h-w1-iso/node_modules/.bin/coodra start` brings up all 4 daemons.
(E) After step D, `curl -sSf -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/` prints `200`. `curl -sSf http://127.0.0.1:3001/api/healthz` returns JSON with the field `ok: true` or `status: ok`.
(F) Run steps D+E TWICE from clean state (`coodra stop || true; rm -rf /tmp/h-w1-*` between runs). Paste both runs' verbatim outputs.

Boundaries: do NOT touch Phase G's `feature-db.ts` verified-JWT path. Do NOT modify `apps/web/` (legacy). Do NOT publish to npm. Do NOT change the existing service descriptors for mcp-server / hooks-bridge / sync-daemon. If the Next.js standalone build fails on native bindings, fix by adding them to `serverComponentsExternalPackages` or `experimental.serverComponentsExternalPackages` — do not strip the bindings.

Stop after 30 turns if not converged; report the failing step + first 50 lines of the relevant log.
