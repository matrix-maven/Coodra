# Goal W3 — Publish 0.1.0-beta.2 and verify public-registry install

> Paste the block below into Claude Code after W2 is green:
>
>     /goal <PASTE THE CONDITION>

---

Web Bundle slice W3 — bump + clean build + isolated re-verify + publish 0.1.0-beta.2 + verify the public-registry install. Assumes W1+W2 done. Plan: /Users/abishaikc/Coodra/web-bundle-plan.md.

Agent-driven steps:
(1) `cd packages/cli && npm version 0.1.0-beta.2 --no-git-tag-version`.
(2) `rm -rf dist .tsbuildinfo && pnpm build` succeeds. `pnpm -r typecheck` clean. `pnpm -r test:unit` reports ≥1048 unit tests pass.
(3) `pnpm pack` produces `coodra-coodra-cli-0.1.0-beta.2.tgz`. Print its byte size + file count + the `npm pack --dry-run` line that lists the file count.
(4) Repeat W1's isolated tarball install + boot acceptance against the new tarball. Verify `curl http://127.0.0.1:3001/` returns 200 and `/api/healthz` returns ok. Twice from clean state. Paste outputs.
(5) Print the EXACT publish command the user runs:
       `cd /Users/abishaikc/Coodra/packages/cli && pnpm publish coodra-coodra-cli-0.1.0-beta.2.tgz --tag beta --no-git-checks --otp <6-digit-OTP-from-authenticator>`
    DO NOT run `pnpm publish` yourself — that requires the user's npm 2FA. Wait.

User-driven step (user pastes the resulting npm output into chat):
(6) After the user pastes a publish success line containing `+ @coodra/cli@0.1.0-beta.2`, continue:

Agent post-publish verification:
(7) `npm view @coodra/cli@beta version` prints `0.1.0-beta.2`.
(8) Public-registry install on this machine (simulates a fresh user):
       `npm uninstall -g @coodra/cli 2>/dev/null || true`
       `npm install -g @coodra/cli@beta`
       `coodra --version` prints `0.1.0-beta.2`.
(9) In a fresh /tmp project: `coodra init && coodra start --no-open`. Wait for daemons. `curl -sSf http://127.0.0.1:3001/api/healthz` returns ok.
(10) Steps 8+9 twice from clean state (`npm uninstall -g`, `rm -rf /tmp/h-w3-*` between runs). Paste both runs.

Acceptance: public-registry install of 0.1.0-beta.2 produces a working `coodra start` with web reachable on :3001 — proved by the agent's curl output. Twice clean.

Boundaries: DO NOT touch the `latest` dist-tag — only the user does that after manually validating beta.2 cross-machine. DO NOT auto-promote.  If `pnpm publish` returns a non-success error from the user, treat their pasted error message as the next-action signal: diagnose, fix, bump to beta.3, repeat steps (1)-(5).

Stop after 25 turns; report the blocker (most likely: native-binding install error on the public-registry install on a non-darwin-arm64 platform — flag that as a known cross-OS concern for W4 to address).
