# Web Bundle Initiative — Master Plan

> This is the final piece of Coodra shipping. Phase H closed the UX gaps
> at the CLI surface; this initiative closes the gap at the WEB surface so
> a single `npm i -g @coodra/cli@latest` gives a fully working
> Coodra in BOTH solo and team mode on ANY machine with Node ≥ 22.
>
> No caveats. No "but you also need to clone the monorepo". No "but you
> also need to deploy the web to Vercel first". One install, full UX.

---

## The end state (user-facing promise)

### Solo user
```bash
npm i -g @coodra/cli@latest
mkdir myproject && cd myproject && git init
coodra init
coodra start
# → daemons up, browser opens to http://localhost:3001/
# → user sees their solo dashboard with /features, /decisions, /packs
# → all data lives in ~/.coodra/data.db (local-first)
```

### Admin spinning up a team
```bash
coodra team init       # wizard handles Postgres, Clerk, browser sign-in
coodra start --tunnel  # web + Cloudflare quick-tunnel public URL
coodra invite jane@acme.com
# → URL contains tunnel hostname (https://abcd.trycloudflare.com/install/<token>)
# → admin shares URL via any channel
```

### Teammate joins (cross-machine)
```bash
# Jane on her laptop (any OS with Node ≥ 22):
curl -sSL https://abcd.trycloudflare.com/install/<token>/cli.sh | sh
# → npm i -g + browser sign-in + redeem invite + daemons up
# → Welcome Jane! Try: coodra feature add my-first-thing
```

No env editing. No two-browser dance. No psql / sqlite3 / sed / openssl. Ever.

---

## Architecture

The CLI tarball already bundles `mcp-server`, `hooks-bridge`, `sync-daemon`,
drizzle migrations, and templates inside `dist/runtime/`. The web becomes
the **fifth bundled runtime** alongside them.

```
@coodra/cli (npm tarball, ~30-50 MB)
├── dist/index.js                       (CLI binary)
├── dist/runtime/mcp-server/index.js
├── dist/runtime/hooks-bridge/index.js
├── dist/runtime/sync-daemon/index.js
├── dist/runtime/web/                   ← NEW
│   ├── server.js                       (Next.js standalone entry)
│   ├── .next/                          (compiled app)
│   ├── public/                         (static assets)
│   └── node_modules/                   (Next.js standalone-traced deps)
├── dist/runtime/drizzle/{sqlite,postgres}/...
└── dist/templates/...
```

`coodra start` already iterates over service descriptors and spawns each
as a managed daemon (launchd on macOS, systemd-user on Linux). The web
becomes a new descriptor; one new spawn call.

---

## Goal sequence — paste each `/goal` condition below after the prior is achieved

Each goal is `/goal`-shaped: one measurable end state, a stated check Claude
can demonstrate in the transcript, and a turn cap. After each goal lights
green, paste the next.

The per-goal condition strings are in `goal-W1.md` through `goal-W4.md`,
each ≤ 4000 chars and ready to paste into `/goal`.

### W1 — Web bundles into CLI, isolated install boots web on :3001
- `apps/web-v2/next.config.ts` → `output: 'standalone'`.
- `packages/cli/scripts/bundle.mjs` → copy `.next/standalone/` + `.next/static/` + `public/` into `dist/runtime/web/`.
- `packages/cli/src/lib/services.ts` → register `web` service (HTTP, port 3001, healthz).
- `coodra start` spawns it like the other daemons.
- Native bindings (`better-sqlite3`, `sqlite-vec`) work in standalone (the largest risk to manage).
- Acceptance: in isolated /tmp install, `coodra init && coodra start` → `curl localhost:3001/` returns 200. Twice clean.

### W2 — Solo dashboard renders real data on every route
- Browse `/`, `/features`, `/decisions`, `/packs`, `/context-packs`, `/policy`, `/sync`.
- Each route returns 200 with expected domain content.
- No 500s. No "TypeError can't read ~/.coodra/data.db". No native-binding crashes.
- Acceptance: write features + decisions via CLI; curl each route in the isolated install; assert content patterns. Twice clean.

### W3 — Publish `0.1.0-beta.2` (with the bundled web)
- Bump version. Clean build, all tests pass, typecheck clean.
- `pnpm pack` → re-verify isolated install of the new tarball.
- Agent prints the exact `pnpm publish ... --tag beta --otp <code>` command.
- User publishes; pastes the npm "+ @coodra/cli@0.1.0-beta.2" output to confirm.
- Agent then `npm i -g @coodra/cli@beta` from public registry on this machine; runs Test 1 + boots web. Twice clean.
- Acceptance: web boots from public-registry install just like the local-tarball install did.

### W4 — Cross-machine via Cloudflare Tunnel (`coodra start --tunnel`)
- Add `--tunnel` flag to `coodra start`.
- If `cloudflared` is on PATH, spawn quick-tunnel; parse `*.trycloudflare.com` URL.
- Atomically write `COODRA_PUBLIC_URL=<tunnel-url>` to `~/.coodra/.env`.
- Print install instructions if `cloudflared` missing; non-fatal (local web still up).
- `coodra invite` URLs use the tunnel host.
- `coodra stop` cleans up the tunnel + reverts COODRA_PUBLIC_URL.
- Acceptance: agent verifies tunnel URL is publicly reachable via `curl <tunnel-url>/api/healthz` from its own terminal. (Public reachability ≡ cross-machine reachability.) Twice clean.

---

## Boundaries (do NOT break)

- Phase G's verified-JWT-beats-config.json invariant — preserved by leaving `feature-db.ts:104-125` alone.
- The 1048-test unit suite — must stay green after every goal.
- `apps/web/` (legacy, deprecated) — do NOT modify or revive; web-v2 only.
- The MCP server / hooks-bridge / sync-daemon runtime bundles — unchanged.
- The `local-team` / `team-hosted` `@deprecated` types — keep them; don't remove.
- The npm package name (`@coodra/cli`) — locked.
- `0.1.0-beta.1` already published — don't unpublish; bump to `beta.2`.

## Proof requirement (every goal)

Each goal's acceptance test must pass **twice from clean state** with verbatim
terminal output pasted. "Clean state" means:
- `/tmp/h-wN-iso/`, `/tmp/h-wN-home/`, `/tmp/h-wN-proj/` deleted between runs.
- For W3 specifically: `npm uninstall -g @coodra/cli` between public-registry runs.

The dual-run requirement matches Phase H's pattern — proves idempotency.

## What the user does

Three concrete actions during this initiative:

1. **W3 publish step**: paste the agent's `pnpm publish ... --otp <code>` command and execute it; paste npm's success output back.
2. **W4 cross-machine verification (optional but recommended)**: spin up a Linux VM or use a second laptop, run the curl|sh installer with a tunnel URL, paste the resulting `Welcome Abishai!` output.
3. **After all 4 goals green**: promote `beta.2` → `latest` if satisfied:
   ```bash
   npm dist-tag add @coodra/cli@0.1.0-beta.2 latest
   ```

Everything else is agent-driven.

---

## What this fixes that Phase H left open

- **Web missing from CLI**: solo users get a dashboard now; team admins don't need the monorepo.
- **Invite URLs unshareable**: tunnel integration makes the admin's local web cross-machine reachable.
- **`COODRA_PUBLIC_URL=http://localhost:3001`** baked into invites: replaced with the tunnel URL when `--tunnel` is set.
- **Doctor check 11/29** (hooks bridge healthz) keeps working; new doctor check for web `/api/healthz`.
- **Auto-open browser at first start**: solo first-run lands on the dashboard, not the terminal staring.

After W1-W4, the CLI is a true single-binary install of the entire Coodra
product. That's the shipping promise.
