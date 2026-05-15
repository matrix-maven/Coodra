# 02 — Agent / Human Boundary (hard line, do not cross)

Coodra is built collaboratively. Some things the agent does autonomously. Others the agent cannot do and must not fake. This file draws the line.

## 2.1 What the agent does (no need to ask every time)

- Read the architecture, write code, edit code, refactor, delete dead code.
- Design local data models and generate migrations (via `pnpm db:generate` — never by hand).
- Write unit, integration, and E2E tests.
- Run local commands: `pnpm`, `npm view`, `uv sync`, `docker compose up/down`, `vitest`, `pytest`, `biome`, `tsc`.
- Start and stop the local docker-compose stack (Postgres + Redis) on the user's machine.
- Configure local-only env vars in `.env` with **dev/dummy values** (e.g., `CLERK_SECRET_KEY=sk_test_replace_me` for solo bypass, `LOCAL_HOOK_SECRET=<random>` generated locally).
- Update documentation (`system-architecture.md`, `External api and library reference.md`, `README.md`, `docs/**`) when the code justifies it.
- Create/update Context Packs under `docs/context-packs/` after completing a feature.
- Create/update entries in `context_memory/` after every tool use (see `03-context-memory.md`).
- Call the Coodra MCP (`coodra__*`) to load feature packs, record decisions, save context packs.
- Research online when docs are stale (see `04-when-in-doubt.md`).

## 2.2 What the user does (never skip, never fake)

The agent must NEVER attempt these itself, and must NEVER invent a stand-in that makes the project *look* done:

- Obtain and supply **production secrets / API keys**: Anthropic, Google Gemini, OpenAI, Clerk Secret, Atlassian OAuth client, GitHub App private key + App ID + webhook secret, Supabase service role key, Upstash Redis credentials, Resend/email provider.
- Create and register **third-party apps**: GitHub App on github.com/settings/apps, Atlassian Connect app, Clerk project, Supabase project, Upstash Redis DB.
- **Install** the GitHub App on the user's org and pick repository scope.
- Grant **org-level permissions** (GitHub org-admin approval, Atlassian site-admin approval).
- Provision **cloud infrastructure**: Supabase (Postgres + pgvector), Railway or Fly.io services, Vercel project, domain + DNS, TLS certificates.
- Configure **production DNS**, CNAMEs, public webhook URLs.
- **Deploy** to any cloud environment (agent may prepare deploy configs but not execute `deploy` against a user account).
- Pay for **paid services** or enable billing on any account.
- Approve **destructive operations**: dropping databases, force-pushing to protected branches, deleting files/branches/PRs, rotating secrets in production.
- Run the product against **real user data** or **production credentials**.

## 2.3 The agent's obligation at every user-action boundary

When a task requires anything in §2.2, the agent must:

1. **Stop** implementing that surface. Do not shim, do not fake.
2. **Record** the required user action in `context_memory/pending-user-actions.md` with:
   - What is needed
   - Why
   - Exactly what the user should do (URL, UI steps, env var name)
   - What to paste back to the agent once done
3. **Ask** the user in chat: clear question, options if any, recommendation, and what to paste back.
4. **Continue** with work that doesn't depend on the blocked surface.
5. **Resume** the blocked surface only after the user confirms completion.

## 2.4 Dummy values vs real secrets

- **Dev/dummy values for solo mode** (e.g., `CLERK_SECRET_KEY=sk_test_replace_me`) are fine when the code's `if (isSolo)` branch explicitly handles the bypass. This is documented in `system-architecture.md` §19.
- **Production secrets** are the user's to provide. The agent never generates, invents, or substitutes them. If the code requires `ANTHROPIC_API_KEY` to function and the user has not supplied one, the feature is not complete — it's blocked. Record and ask.
