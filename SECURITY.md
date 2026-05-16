# Security Policy

## Reporting a vulnerability

If you believe you have found a security issue in Coodra — credential leakage, a way to bypass the policy engine, a sandbox escape from the hook adapter, an auth-chain weakness, anything that could compromise a user's machine or their team's data — please report it **privately**.

Email: **abishai95141@gmail.com**

Please include:

- A clear description of the issue and its impact.
- Steps to reproduce, or a proof-of-concept.
- The Coodra CLI version (`coodra --version`), your OS, and your Node version.
- Whether you have already disclosed this issue to anyone else.

We will acknowledge your report within 72 hours and aim to have an initial assessment and a remediation timeline within 7 days.

Please **do not** open a public GitHub issue, post about the vulnerability on social media, or share it with third parties until we have published a fix.

## Supported versions

Coodra is in public beta. Security fixes land on the most recent `@coodra/cli@beta` tag on npm and `main` on GitHub. Older beta versions are not patched.

| Version | Supported |
| --- | --- |
| `0.2.x-beta.*` (current) | yes |
| anything older | no — please upgrade (`coodra upgrade`) |

## Scope

In scope:

- `@coodra/cli` and the daemons it spawns (`mcp-server`, `hooks-bridge`, `sync-daemon`).
- The web UI (`apps/web-v2`) when run locally or self-hosted from this repo.
- The migration tooling (`coodra cloud-migrate`, `coodra team setup`).
- The hook adapter shell scripts under `scripts/hook-adapters/`.

Out of scope:

- Third-party services Coodra integrates with (Clerk, Supabase, Anthropic) — please report to the vendor directly.
- Issues in user-authored Feature Packs, Context Packs, or policy rules — those are project content, not Coodra code.
- Denial-of-service against a user's own local daemons (e.g. exhausting their SQLite). Local DoS is a developer concern, not a security boundary.

## What we will and will not do

- We will credit reporters in the release notes for the fix unless they prefer to remain anonymous.
- We do not currently run a paid bug bounty program.
- We will not pursue legal action against good-faith security research that follows this policy.

Thank you for helping keep Coodra and its users safe.
