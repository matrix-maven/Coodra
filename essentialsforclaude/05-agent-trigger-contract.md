# 05 — Agent Trigger Contract: When to Call Coodra Tools

The Coodra MCP server exposes 26 tools. Their `tools/list` manifest — with full descriptions, input schemas, and return shapes — is specified in `../system-architecture.md` §24. That section tells the agent **what** each tool does and **when it applies**; this file converts those into **directive rules you must follow** while operating on this repo.

> **If you do not call these tools, Coodra does not exist.** The hooks and services described in the architecture are only reachable because the agent's planner decides to invoke the MCP tools. Skipping the triggers below breaks the entire coordination layer — Feature Packs never load, policy never evaluates, context packs never save, prior decisions are forgotten. Follow these rules as if they were runtime preconditions, because for the architecture they are.

## 5.1 Session start — FIRST, in parallel, before any other tool call

> **Bridge-mediated autonomous default (Pattern 20, decision `dec_83ba10c1`, 2026-05-02):** when the project is set up via `coodra init`, the hooks-bridge fires Feature Pack injection on Claude Code's SessionStart hook and returns the project-level pack via `additionalContext`. You therefore receive the pack at turn zero *before* this trigger contract runs. The MCP calls below are still required so the agent has its **own** `runId` for `record_decision` / `save_context_pack` and so non-bridge agents (Cursor, Windsurf, raw API) get the same coverage.

### Two knowledge layers — never confuse them

Coodra exposes two distinct knowledge surfaces. They look similar at a glance but have opposite trigger models, and the difference matters at SessionStart:

| | **Feature Packs** | **Features** |
|---|---|---|
| What | Architectural blueprint of one **module** (spec.md + implementation.md + techstack.md + meta.json). | Atomic, callable **skill** — single markdown + YAML frontmatter (description / triggers / whenNotToUse) + optional supporting files. |
| Trigger model | **Push.** Injected via hooks-bridge `additionalContext` at SessionStart; you ALWAYS have the project's pack. | **Pull.** Indexed at SessionStart; you fetch a feature ONLY when a user prompt matches its trigger description. Same pattern as Anthropic Skills. |
| Granularity | One per logical module (~5–20 per project). | One per reusable skill (20–100+ as the team matures). |
| Fetch tool | `coodra__get_feature_pack` (rarely needed — see step 2 below). | `coodra__list_features` once, then `coodra__get_feature` per matching slug. |
| Filesystem | `<project-root>/docs/feature-packs/<slug>/` | `<project-root>/docs/features/<slug>/feature.md` |
| When to use | Constraints + conventions + permitted files for the area of the codebase you're editing. | Specific how-to that gets pulled in only when the conversation actually needs it. |

If you find yourself asking "should I use a feature pack or a feature for this?" the answer is: **module-wide architectural constraints → feature pack; on-demand skill that matches a user prompt → feature.** Never load every feature blindly; the pull model is the whole point.

### SessionStart calls

1. `coodra__get_run_id { projectSlug, agentSessionId?, agentType? }` — obtains the `runId` that binds every subsequent call in this session. Cache the result; reuse it. **Pass `agentSessionId` set to the same `session_id` you fire at the hooks-bridge SessionStart hook**, plus `agentType` (`claude_code | cursor | windsurf`). Without these, MCP creates a separate `runs` row keyed on the transport-generated sessionId — the bridge SessionStart row and this MCP `runs` row will not agree. Closes verification F9 (run-identity reconciliation) and F10 (`agent_type='unknown'` on MCP-minted rows).
2. `coodra__get_feature_pack { projectSlug }` (PUSH layer — modules) — call this only if (a) the bridge did not inject an `additionalContext` at session start (non-Claude agents, or Claude in environments where the bridge is offline), or (b) you are switching to a new module mid-session and need the pack scoped to a specific `filePath`. Otherwise the bridge already loaded the project-level pack on your behalf.
3. `coodra__list_features { projectSlug }` (PULL layer — skills) — call once per session to discover the available skills. Read each description; DO NOT call `get_feature` for any of them yet. Wait until a user prompt actually matches a feature's trigger before pulling it via `coodra__get_feature { projectSlug, slug }`. Soft-fails gracefully on projects with no `docs/features/` directory — that's fine, the project has no skills (yet).
4. `coodra__query_run_history { projectSlug, status: 'in_progress', limit: 1 }` — checks whether a previous session left work in-flight.
5. `coodra__search_packs_nl { projectSlug, query: <brief summary of what you are about to build> }` — retrieves prior context packs on the topic so you don't duplicate or contradict past work.

If the previous session left an `in_progress` run, read its `context_memory/current-session.md` and "Next action" (see `03-context-memory.md`) before deciding whether to start something new.

If `runs.issueRef` is set on the in-progress run AND Atlassian's Rovo MCP is wired (`coodra jira enable`), also call Rovo's `getJiraIssue { issueIdOrKey: <issueRef> }` (§5.7 — this is Atlassian's tool, not a Coodra tool).

If `runs.prRef` is set on the in-progress run AND the GitHub integration is active, also call `github_get_pr_context { prRef: <prRef> }`.

## 5.2 Before every file write, create, or delete — non-negotiable

```
coodra__check_policy({
  projectSlug, sessionId: runId, agentType: 'claude_code',
  eventType: 'PreToolUse',
  toolName: 'write_file',          // or 'edit_file', 'delete_file'
  toolInput: { file_path: '...' }
})
```

- `permissionDecision === 'deny'` → **STOP.** Do not attempt a workaround, do not call a sibling tool, do not retry. Report the `reason` and ask how to proceed.
- `permissionDecision === 'ask'` → surface the question to the user verbatim and wait.
- `permissionDecision === 'allow'` → proceed.

If the file is in an area of the codebase you have not yet loaded a Feature Pack for, ALSO call `coodra__get_feature_pack { projectSlug, filePath }` before the write.

## 5.3 Before every shell command

```
coodra__check_policy({ ..., toolName: 'bash', toolInput: { command } })
```

Same decision rules as §5.2. Commands that modify state (package installs, migrations, git operations, file deletions) are the ones that most often get denied.

## 5.4 At every design decision — immediately, not at session end

Any of the following triggers `coodra__record_decision`:

- You picked library A over library B.
- You designed an API shape or data schema.
- You chose an implementation approach over an alternative.
- You decided NOT to implement something (deferral, scope cut).

```
coodra__record_decision({
  runId,
  description: "One sentence: what was decided",
  rationale: "Why this approach over alternatives",
  alternatives: ["option A", "option B"]
})
```

Do not batch these. Do not wait for `save_context_pack`. Log each as you make it — if the session is interrupted, unlogged decisions are lost.

## 5.5 When the user asks about prior work

Triggers: *"what was done before?"*, *"has X been tried?"*, *"what is the state of Y?"*, *"why did we choose Z?"*.

1. `coodra__query_decisions { projectSlug, query?, runId?, limit: 10 }` — direct read of the `decisions` table for this project. Use this **first** for "what did we decide about X?" / "why did we pick Y?" — every `record_decision` call is durable history and this is the authoritative read-path. Quoted descriptions and rationales surface verbatim; if a query string is supplied it LIKE-matches against description+rationale.
2. `coodra__search_packs_nl { projectSlug, query }` — semantic search over prior context packs (LIKE-substring fallback until M05 NL Assembly ships embeddings).
3. `coodra__query_run_history { projectSlug, limit: 10 }` — chronological recent runs.
4. Answer from the retrieved data. **Do not answer from memory.** If all three return empty, say so — don't confabulate.

## 5.6 Before structural refactors or unfamiliar code navigation

Triggers: *"refactor X"*, *"rename Y across the codebase"*, *"where is Z defined?"*, *"what depends on A?"*.

When the **Graphify integration is active** (Module 09 track 9B — the `graphify` MCP server is wired into your config), call its tools to find blast radius before touching shared code: `query_graph` (natural-language query → scoped subgraph), `get_node`, `get_neighbors`, `shortest_path`. Graphify is consumed via its **own** MCP server (ADR-010, Option C) — Coodra does not wrap it. If Graphify is not configured, fall back to reading files. The former `coodra__query_codebase_graph` tool is retired — see ADR-010 and `system-architecture.md §17`.

## 5.7 Jira triggers (when Atlassian's Rovo MCP is wired — `coodra jira enable`)

**These tools are NOT Coodra's.** Jira is consumed **Direct** (ADR-016): `coodra jira enable` wires **Atlassian's Rovo MCP** alongside the `coodra` server, and the agent calls Rovo's own Jira tools. Coodra advertises no `jira_*` tools. The table maps user intent → the **Rovo** tool name. If the Rovo server is not wired (no `atlassian` entry in the agent config), these tools are simply absent from `tools/list` — do nothing Jira-related and continue.

| User intent | Rovo tool (Atlassian-owned) |
|---|---|
| References a key like `PROJ-123` | `getJiraIssue { issueIdOrKey: 'PROJ-123' }` |
| "My open tickets" / implicit pronoun for a ticket | `searchJiraIssuesUsingJql { jql: 'assignee = currentUser() AND statusCategory != Done' }` |
| Query by text rather than key | `searchJiraIssuesUsingJql { jql }` |
| Discover accessible project keys | `getVisibleJiraProjects` |
| Move a ticket's state | `getTransitionsForJiraIssue` (find the id) → `transitionJiraIssue` |
| Add a comment (explicit user request only) | `addCommentToJiraIssue` |
| Edit ticket fields (explicit user request only) | `editJiraIssue` |
| Create a new ticket (explicit user request only) | `createJiraIssue` |

**Coodra-side Jira triggers (these ARE Coodra tools):**
- When the user names or references a Jira issue this session is for ("work on PROJ-123", a `feature/PROJ-123` branch), call Coodra's **`link_run_to_issue { runId, issueRef }`** to bind `runs.issueRef`. This makes Coodra history Jira-aware: `query_run_history` and `query_decisions` each take an optional `issueRef` filter — "what touched PROJ-412?" / "what was decided for PROJ-412?". Records a local link only (no Jira call); an unknown runId returns `run_not_found`.
- At session end, **only if the user asks**, call Coodra's **`prepare_jira_comment { runId }`** to assemble the summary `{ issueRef, body }` from the run's Context Pack + decisions, then post the returned `body` to the linked issue via Rovo's `addCommentToJiraIssue { issueIdOrKey, body }` (the write-back path, §22.6). `prepare_jira_comment` soft-fails `not_linked` if the run has no issue (call `link_run_to_issue` first). Never post unprompted.

**Never post comments, create tickets, or transition issues unprompted.** Jira is shared state and noise has a cost. (Note: the verified Rovo surface has no dedicated issue-link tool — the old `jira_link_issues` intent has no 1:1 Rovo equivalent; use `editJiraIssue` or defer.)

## 5.8 GitHub triggers (when the GitHub integration is active)

| User intent | Tool |
|---|---|
| Session starts with an open PR on the current branch | `github_get_pr_context` |
| References a PR by number | `github_get_pr_context` (if reviews needed), else `github_get_pr` |
| "What did reviewers say?" | `github_list_pr_comments` |
| "Who owns this file?" | `github_get_codeowners { filePath }` |
| Before writing to a non-default / protected branch | `github_get_branch_protection` |
| "What needs my review?" | `github_list_my_reviews` |
| Debugging why a line exists / blame investigation | `github_get_blame { filePath, startLine, endLine }` |
| References a GitHub issue (not PR) | `github_get_issue` |
| Post a PR comment | `github_post_pr_comment` — **ONLY** if the `allow_agent_pr_comment` policy rule is true AND the user explicitly asked |

## 5.9 At session end — mandatory for narrative recaps; auto-fired by the bridge for routine runs

> **Bridge-mediated autonomous default (Pattern 20, decision `dec_83ba10c1`, 2026-05-02):** the hooks-bridge fires `contextPack.save(...)` on every Stop / SessionEnd hook with a structured auto-summary built from `run_events` + decisions. So a Context Pack lands for every Claude Code session even if the agent never calls this tool. **You should still call `save_context_pack` explicitly** when the work warrants a richer narrative recap than the structured digest — i.e., feature/bugfix/refactor closeouts, complex multi-decision sessions, anything you want a future agent to *read*. Append-only semantics (ADR-007) hold: if the bridge already wrote a pack for this `runId`, your explicit call returns the existing row unchanged — your richer content does NOT overwrite the auto-summary. To replace the auto-summary, you must call this tool **before** the SessionEnd hook fires (typically when the user signals "we're done" but before they close the session).

When the feature/bugfix/refactor is complete and tests pass:

```
coodra__save_context_pack({
  runId,
  title: "One-line title of what was built",
  content: "Full markdown: what was done, decisions made, files modified, test results, open TODOs, flags for next session",
  featurePackId: <if applicable>
})
```

This is the on-demand handoff mechanism for narrative recaps. The structured auto-summary is the safety net. See `03-context-memory.md` for how this relates to the session-level `current-session.md`.

## 5.10 Failure modes and fallbacks

| Situation | What to do |
|---|---|
| MCP server unreachable at session start | Fall back to direct HTTP to `http://127.0.0.1:3100/mcp`. If that also fails, note it and proceed — do not block the user. |
| `check_policy` returns `deny` | STOP. Do not retry. Do not call sibling tools to work around. Report and ask. |
| A tool returns `{ ok: false, error: 'integration_unavailable' }` | The integration (JIRA, GitHub) is down or not configured. Continue work that doesn't depend on it. Flag in `context_memory/blockers.md` if it persists. |
| `save_context_pack` fails | Retry once. If it still fails, write the same content to `context_memory/sessions/<timestamp>-<topic>.md` manually so the work is not lost, and flag in `context_memory/blockers.md`. |
| A tool description in `tools/list` looks wrong or outdated | Do NOT "guess around it". Raise it in `context_memory/open-questions.md` and ask. The manifest is the contract. |

## 5.10b Deep Wiki triggers (Module 10, ADR-017)

When the user asks to **generate / build / refresh the deep wiki** (or "document
the architecture as a wiki"), they will usually have run `coodra wiki generate`
first — which writes the per-run job (`.coodra/wiki-job.md`) + a grounding
snapshot (`.coodra/wiki-grounding.md`) and scaffolds the `deep-wiki-author`
Feature. **You are the model; Coodra runs no LLM.** Run the two-pass flow:

1. `coodra__get_run_id { projectSlug }` → `runId`. Read `.coodra/wiki-grounding.md`
   (and, if Graphify is wired, `query_graph` / `get_neighbors` for real
   structure).
2. **Pass 1** — plan a `WikiStructure` (sections + pages: id, title,
   description, importance, parentId for the hierarchy, relevantFiles,
   relatedPageIds, wantsDiagram) and persist it:
   `coodra__wiki_save_structure { runId, slug, structure }` → keep the `wikiId`
   + `pendingPageIds`.
3. **Pass 2** — for each pending page, read its `relevantFiles` and author
   Markdown (with a ```mermaid diagram where `wantsDiagram`) via
   `coodra__wiki_save_page { runId, wikiId, pageId, content }`. Use
   `coodra__wiki_status { wikiId }` to see what's still pending and to resume in
   a later session. Re-calling `wiki_save_structure` with the same slug re-plans
   (replaces) the wiki.

Both `wiki_*` outputs use the canonical soft-failure shape (`run_not_found`,
`auth_required`, `wiki_not_found`, `page_not_in_structure`) — check
`response.ok && response.data.ok`. The result renders in the web app at `/wiki`.

## 5.11 What NOT to do

- Don't call `check_policy` once and assume the answer holds for the rest of the session. Every write is a new check.
- Don't treat `get_feature_pack` as a one-time call if you change areas of the codebase — re-call when you switch modules.
- Don't batch `record_decision` calls for the end of the session. Log each as it happens.
- Don't skip `save_context_pack` because "the user will remember." The user won't; the next session definitely won't.
- Don't call tools that don't apply — `github_*` with no GitHub integration (returns `integration_unavailable`), or Rovo's Jira tools (`getJiraIssue`, `searchJiraIssuesUsingJql`, …) when Atlassian's Rovo MCP isn't wired (they're simply absent from `tools/list`, not a Coodra error). Check `runs.issueRef` / `runs.prRef` presence first.
- Don't invent tool names. If the tool isn't in `tools/list`, it doesn't exist.
