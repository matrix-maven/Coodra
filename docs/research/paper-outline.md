# Research Paper: Annotated Outline & Working Plan

Status: draft outline, 2026-08-19
Target: arXiv preprint, 8–10 pages (two-column) / ~7,000–8,500 words
Genre: systems + position paper with proposed measurement methodology
Evidence posture: design and taxonomy grounded in deployed implementation; empirical
evaluation explicitly deferred and named as such.

---

## 0. The one-sentence thesis

> **Agent memory systems are unfalsifiable in production: the dominant delivery
> mechanism — pushing context into the window — emits no signal that the agent
> ever used it. Progressive disclosure is therefore not primarily a token-efficiency
> technique but an *instrumentation* technique: it converts an unobservable push
> into an observable act of retrieval.**

Everything else in the paper is downstream of that sentence. If a section does not
serve it, cut the section.

### Why this thesis and not the obvious one

The obvious thesis — "richer persistent memory makes coding agents better" — is
already contradicted by published work (§3 below). Do not write that paper. It
would be refuted by a reviewer who has read one 2026 preprint, and it is a claim
the current data cannot support.

The observability thesis is stronger for three reasons:
1. It is **true given the evidence we have**, including the negative results.
2. It **survives the negative results** — indeed it explains them. If nobody can
   measure whether memory is retrieved, nobody should be surprised that adding more
   memory does not help.
3. It is **novel**. The memory literature evaluates via offline benchmarks. Nothing
   in the surveyed work instruments a deployed memory layer and asks whether its
   artifacts are ever read.

---

## 1. Contributions (state these explicitly in §1; reviewers look for the list)

**C1 — A lifecycle model for agent memory artifacts.**
Created → Surfaced → Pulled → Stale/Contradicted. Existing systems and dashboards
report only stage 1 (inventory). We argue stages 2–4 are where the failures live and
give a schema that records them.

**C2 — The push/pull observability asymmetry.**
A formal statement of why pushed context is epistemically inert: it consumes budget,
cannot be retracted, and produces no evidence of use. Pulled context costs a tool call
but yields a *revealed preference* signal. This reframes progressive disclosure.

**C3 — Irrevocability and compaction as first-class memory-system events.**
The memory literature models context as an append-only buffer. Real harnesses do
neither: injected text cannot be un-injected, and compaction destroys grounding
lossily and repeatedly. We introduce `baseline_generation` as the unit against which
deltas and invalidations are defined.

**C4 — Computable staleness for code-grounded memory.**
Conversational memory has no ground truth against which a memory can rot. Repository
memory does: the commit graph. `verified_against_commit` / `verified_against_files`
makes "is this still true?" a mechanical query rather than an agent's declaration —
and distinguishes it from supersession ("has this been replaced?").

**C5 — A measurement methodology and reference instrumentation.**
`memory_access_events`, its two rollup grains, retention invariants, and the
`session_id` join to agent-native OpenTelemetry. Released as an open-source
implementation.

Pick **three** of these as headline contributions if the paper runs long. C2 and C3
are the most novel; C1 is the organizing frame; C4 is the most coding-agent-specific;
C5 is the artifact. My recommendation: headline **C1, C2, C3**, present C4 and C5 as
components.

---

## 2. Title candidates

1. *Push Is Unobservable: Progressive Disclosure as Instrumentation for Agent Memory* — sharpest, states the thesis.
2. *What Does the Agent Actually Read? A Measurement Architecture for Coding-Agent Memory*
3. *Surfaced, Pulled, Stale: A Lifecycle Model for Persistent Memory in Coding Agents*
4. *Memory You Cannot Measure: Observability Gaps in Agentic Coding Harnesses*

Prefer (1) or (3). Avoid naming Coodra in the title — the system is evidence, not the
subject.

---

## 3. Related work — the real map

Read these **before drafting §2**. Three of them constrain what you may claim.

### 3.1 The threat papers (must be cited, must be engaged, cannot be ignored)

| Work | Finding | Why it threatens you | How you absorb it |
|---|---|---|---|
| *Do Context Files Help Coding Agents? A Two-Agent Ablation* (arXiv 2607.27250) | 288 runs, Claude Code + Codex, 3 repos. Context files give **no measurable correctness gain** (bounded ≤10–15pp). Failures are implementation skill, not missing knowledge. | Kills any "memory improves task success" framing outright. | **Cite in the first paragraph of §1 as motivation, not as an obstacle.** Their null result is your premise: if the content channel does not move correctness, the interesting question is no longer "what should we put in memory" but "is any of it retrieved, and what does it cost." Their own failure analysis — agents did not lack repository knowledge — is direct support for your reframing. |
| *Is Progressive Disclosure All You Need for Long-Context Agents?* (arXiv 2607.17598) | First controlled study. Gains are **large only when the agent navigates poorly**, near zero with a strong harness; benefits appear as corpus scales; **one disclosure level is enough — two breaks accuracy.** | Partially pre-empts C2 if you frame progressive disclosure as an efficiency win. | **This validates you.** Their "one level is enough" is exactly the manifest→body design converged on independently. Cite as convergent evidence. Then state the gap plainly: they study single-instance document QA, **not** cross-session persistence, not coding agents, and — critically — they measure *accuracy*, not *whether retrieval happened*. Your claim is orthogonal: even where disclosure yields no accuracy gain, it yields a measurement channel that push cannot. |
| *Agent READMEs: An Empirical Study of Context Files* (arXiv 2511.12884) | Mines CLAUDE.md / AGENTS.md across OSS. Devs write build commands (62.3%), implementation detail (69.9%), architecture (67.7%); security/performance ~14.5%. | Not a threat — a gift. | Use for §2's empirical grounding on *what* file-based memory actually contains, and for the argument that files skew toward the static and easily-stale. |

Also worth citing: *Instruction Adherence in Coding Agent Configuration Files*
(arXiv 2605.10039) and *Rule Taxonomy and Evolution in AI IDEs* (arXiv 2606.12231).

### 3.2 Memory architectures

- **MemGPT / Letta** (arXiv 2310.08560) — the OS analogy: context window as RAM, recall +
  archival stores as disk, agent-issued function calls to page in/out. **Your closest
  ancestor.** Position against it: MemGPT pages within a session for a conversational
  agent and treats the agent's own paging calls as the mechanism; you treat those same
  calls as the *measurement*. Also: MemGPT has no notion of an artifact going stale
  against an external ground truth, and no notion of retraction.
- *Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers*
  (arXiv 2603.07670) — the current survey. Write–manage–read loop; 3-D taxonomy
  (temporal scope / representational substrate / control policy); five mechanism
  families. **Use its vocabulary** so reviewers can place you: you are proposing an
  observability layer over the *read* edge of write–manage–read.
- *Governing Evolving Memory in LLM Agents (SSGM)* (arXiv 2603.11768) and
  *A Survey on the Security of Long-Term Memory in LLM Agents* (arXiv 2604.16548) —
  adjacent governance framing; cite when you discuss policy and gardening autonomy.
- *DeltaMem* (arXiv 2606.03083), *MemReranker* (arXiv 2605.06132) — incremental and
  reranked memory; cite briefly to show awareness of the retrieval-quality axis you
  are explicitly not competing on.

### 3.3 Evaluation of memory

- **LoCoMo**, **LongMemEval**, **MemBench**, **MemoryAgentBench**, **StreamMemBench**
  (arXiv 2606.14571), **GateMem** (arXiv 2606.18829, multi-principal shared memory —
  relevant to team mode).
- **The argument you make here is the paper's second-strongest move:** every one of
  these is an *offline benchmark with ground-truth queries*. None can be run against a
  deployed system on a real repository with real developers, because none of them
  observes retrieval in situ. Benchmarks answer "could this memory system retrieve the
  right thing on our corpus"; nobody answers "is the memory in *your* project ever
  read." Name this the **benchmark/production gap**.
- MemoryAgentBench's finding that most systems fail at *selective forgetting* is a
  direct hook into C4 (staleness) — cite it there.

### 3.4 Context degradation

- **Lost-in-the-middle** (Liu et al., TACL 2024) — positional, U-shaped.
- **Context rot** (Chroma, 2025; 18 frontier models) — length-driven, holds even with
  favourably-placed evidence.
- Be precise about the distinction — the literature conflates them constantly and a
  reviewer will notice if you do. Positional degradation vs. length degradation are
  different phenomena with different implications: the first argues for *placement*,
  the second for *budget*. Your manifest design is motivated by the second.

### 3.5 Practitioner sources (cite as grey literature, clearly labelled)

- Anthropic, *Effective context engineering for AI agents* — "lightweight identifiers,
  load at runtime." This is the canonical statement of the pattern you instrument.
- OpenAI, *Harness engineering: leveraging Codex in an agent-first world* (2026-02-11) —
  AGENTS.md as table of contents, mechanical doc-freshness enforcement, doc-gardening
  agents, lint messages as agent context.
- Both are engineering blog posts. Cite them honestly as such. A first-time author
  gets credit for labelling grey literature correctly and loses credibility for
  dressing a blog post as a study.

---

## 4. Section-by-section outline with word budget

### §1 Introduction (~900 words)

Open with the null result, not with a claim. Roughly:

> Persistent context files are now standard practice for agentic coding. A recent
> controlled ablation across two frontier agents and 288 runs found that they produce
> no measurable improvement in task correctness. This is a striking result for a
> practice adopted this widely — and we argue it is less a verdict on memory than a
> symptom of an instrumentation gap.

Then: the four-stage lifecycle, the observation that every deployed system reports
stage 1, the push/pull asymmetry in one paragraph, and the contribution list.

Close §1 with an explicit **scope statement**: this is a systems and measurement paper;
we do not report a controlled evaluation of retrieval quality, and we say why in §8.
Declaring this in §1 rather than burying it converts your biggest weakness into a
demonstration of rigour. Reviewers punish concealed limitations far more than
acknowledged ones.

### §2 Background: what the harnesses actually do (~1,100 words)

This is the section only you can write, and it is a genuine contribution — there is no
careful published description of these mechanics. Be concrete and version-stamped.

- **Static instruction files.** CLAUDE.md / AGENTS.md, load points, precedence,
  hierarchical discovery. Cite *Agent READMEs* for what they contain in practice.
- **Session lifecycle and hooks.** SessionStart, UserPromptSubmit, PreToolUse,
  PostToolUse, Stop, SessionEnd, PreCompact. What each can and cannot inject.
- **Compaction.** Both harnesses summarize and truncate on window pressure. Repeated
  compaction is lossy over the *previous* pass's output, so error compounds. Six-hour
  sessions are routine.
- **Subagents and isolated context.** Fan-out returns a report, not a transcript —
  a memory boundary that no published model accounts for.
- **MCP as the retrieval surface.** Tools are the only channel through which an agent
  can *pull*, and therefore the only channel that can be instrumented per-artifact.
- **Agent-native telemetry.** Claude Code emits `session.id` on OTel metrics/spans;
  Codex CLI 0.148.0-alpha.9 carries `thread.id`/`session_id` and a full token
  breakdown (`codex.turn.token_usage.*`). **Verified by direct binary inspection, not
  documentation** — say so; it is a methods detail that buys credibility.

**Table 1** belongs here: harness capability matrix (injection points × retraction ×
compaction hooks × native telemetry) across Claude Code, Codex, and — as coverage
contrast — Cursor, Devin, Antigravity.

### §3 Failure taxonomy (~1,200 words) — the heart of the paper

Five failures, each stated as a mechanism, then a concrete instance, then what it
would take to detect. Derived from the PRD's problem section; sharpen each into a
named phenomenon so others can cite them.

- **F1 — Unobservable delivery.** Context is selected, rendered, and forgotten. No
  record of what was surfaced survives the injection.
- **F2 — Irrevocability.** Push is a one-way write to an append-only transcript. A
  pack injected at hour 0 describing a superseded approach is still verbatim at hour 3.
  Filtering superseded items out of *new* injections cannot un-inject old ones.
  *A file can be re-read after it is fixed; a transcript block cannot.*
  (This line is the best sentence in the source material — keep it.)
- **F3 — Compaction amnesia.** Grounding degrades to whatever the harness summarizer
  preserved, while per-prompt injections keep arriving on top of it. Baselines become
  undefined; deltas are emitted against a baseline no longer in the window.
- **F4 — Declared vs. computable freshness.** Supersession edges exist only when an
  agent bothers to record one. Nothing checks whether a memory still describes how the
  code behaves. **Ranking a stale artifact into position 1 is worse than retrieving
  nothing.**
- **F5 — Inventory metrics as vanity metrics.** Counts rise when the system nags
  effectively, and look healthy on a project where every artifact is noise nobody
  reads. Name the two north stars — pull-through rate and stale share — and the most
  expensive failure of all: **surfaced-then-contradicted**, where retrieval worked and
  the agent went the other way anyway. That is the failure that separates "we failed to
  retrieve" from "retrieval works and nobody listens."

**Figure 1** here: the lifecycle diagram with each failure annotated at the stage it
occurs.

### §4 Design: progressive memory (~1,400 words)

Frame every choice as *derived from* a failure in §3. Do not present a feature list.

- **Manifest over excerpt** (→F1, F5). Push ids, titles, one-line summaries, tier,
  freshness state; pull bodies by tool. Rationale is observability first, tokens
  second. Cite 2607.17598 for one-level-is-enough as convergent independent evidence.
- **Generational baselines** (→F2, F3). `baseline_generation` increments per
  compaction; prompt-time context becomes *query live state, diff against what this
  generation has surfaced, emit only deltas and invalidations*. Re-emit the manifest
  after compaction rather than once per session.
- **Computable freshness** (→F4). `verified_against_commit` / `verified_against_files`,
  and the deliberate refusal to add a `superseded_by` column: supersession lives in
  edges, freshness is a different property, two sources of authority is worse than the
  ambiguity it fixes. **Include this refusal in the paper** — negative design decisions
  with stated reasons are what distinguish a systems paper from a product description.
- **Two staleness measures, never one.** Short-term churn (superseded within a run,
  fixed by better mid-session invalidation) vs. long-term rot (verified-against files
  drifted over weeks, fixed by gardening cadence). Collapsing them into one
  "staleness %" hides the fact that they have different fixes.
- **Gardening.** Marks and proposes; never silently rewrites user memory. Position
  against OpenAI's doc-gardening agent: same pattern, database rather than PRs.
- **Just-in-time teaching.** Remediation delivered at the moment of a policy denial —
  never stale, never budget-consuming. Explicitly a narrow channel: permission events
  fire only on gated actions and cannot carry general grounding. Saying what a
  mechanism *cannot* do is worth a paragraph.
- **Graph freshness as a prerequisite**, and the sharper sub-result: node ids are
  path-derived, so refreshing more often trades staleness for **dangling pointers,
  which fail quieter**. Hence: resolvable pointers, not foreign keys; resolve at read
  time and record `resolved`/`moved`/`missing` so identity drift is itself measurable.
  This is a genuinely non-obvious finding — give it its own subsection.

**Figure 2**: `SessionStart manifest → MCP pull → DB freshness/gardening → prompt-time
invalidation`, with the generational boundary drawn across it.

### §5 Instrumentation (~900 words)

- `memory_access_events`: the `site` (which door) vs `memory_type` (what came through
  it) separation; `freshness_status_at_access` as a point-in-time snapshot so later
  rot cannot rewrite history; `baseline_generation` so a pull is attributed to the
  manifest generation that surfaced it.
- **The attribution hazard.** Current-run attribution, retrieval-filter inputs, and
  artifact-level access rows are three distinct concepts. Overloading a `runId` input
  for attribution would silently narrow retrieval semantics. Resolve the run at
  registry level from the session, never from tool arguments; a miss writes `null` and
  increments a counter rather than guessing. **Cite the real prior bug** where a
  lookup called with an undefined slug wrote `run_id IS NULL` on every row. A systems
  paper that admits a shipped bug and shows the design that prevents its recurrence is
  more persuasive than one that does not.
- **Rollups.** Two grains because one cannot serve both metric families: a daily grain
  for volume/cost, a cohort grain keyed on `(run, generation, memory_id)` for
  pull-through. **No stored percentiles** — averaging daily p95s is not the p95 of the
  union; use totals, max, and count (all of which compose), or fixed histogram buckets.
  This is a small point that signals real engineering.
- **Retention invariant**: a raw row is never deleted until its day is rolled up.
- **Privacy**: ids, counts, hashes, byte costs. Never raw prompt text by default.
  Acknowledge the cost honestly — hashes count repeats but cannot diagnose; "the wiki
  has holes" is actionable only with the actual questions. Hence plaintext capture as
  opt-in and local-only.
- **The OTel join.** `session.id` / `thread.id` → `runs.session_id` → `run_id`. No
  injection, no schema change. Also the asymmetry worth stating: utilization telemetry
  is not derivable from agent-native OTel at any level of effort, because no agent
  knows what a context pack or a supersede edge is — and precisely because it is
  self-instrumentation, it works uniformly across all five agents while native OTel
  covers two.

### §6 Proposed evaluation (~700 words) — *proposed*, and labelled as such

- **Layer 1, deterministic, offline.** Fixed corpus; Recall@k, distractor rate,
  injected bytes. Catches the two opposite predicted failure modes of the manifest
  change: the old model bloats, the new one under-retrieves. Runs in CI in under a
  second.
- **Layer 2, counterfactual.** Three arms (no memory / push excerpts / manifest+pull),
  LLM judge, confidence intervals. Specify it; state it is not yet run.
- **Production observation.** Pull-through rate, stale share, time-to-first-pull,
  never-surfaced share, surfaced-then-contradicted.
- **Power analysis, borrowed from 2607.27250.** They needed ~120 tasks to detect 10pp
  and had 15–17. Use their number. Showing you know the sample size your claim would
  require, and that you do not have it, is exactly the move that makes a
  design-paper's deferral credible instead of evasive.

### §7 Threats to validity (~450 words)

Do not soften these.

- **Single system, single team, n=1 repository.** The design is validated by
  construction, not by adoption.
- **No outcome evidence.** Pull-through measures *wanted*, not *useful*. An agent can
  pull a body and ignore it. State this plainly; it is the honest ceiling on C2.
- **Predicted under-retrieval.** Agents do not reliably call tools nobody told them to
  call. This is the manifest model's known failure mode and the reason for
  push-the-index-pull-the-body rather than pull-only. Report it as a risk you designed
  against, not one you have disproved.
- **Harness versions move.** Version-stamp every mechanic in §2.
- **Observer effect.** Instructing an agent to pull changes what it pulls; the
  measurement is not passive.

### §8 Conclusion (~350 words)

Restate the thesis. The actionable ask to the field: memory systems should report
utilization alongside inventory, and benchmarks should be complemented by in-situ
observation. Point at the released implementation.

---

## 5. Figures and tables (build these before drafting prose)

| # | Type | Content |
|---|---|---|
| Fig 1 | Diagram | Four-stage lifecycle with F1–F5 annotated at their stage |
| Fig 2 | Diagram | Delivery pipeline with generational boundary |
| Fig 3 | Diagram | Push vs pull, showing where a signal is emitted and where none is |
| Tab 1 | Matrix | Harness capabilities × 5 agents |
| Tab 2 | Schema | `memory_access_events` columns and rationale (condensed) |
| Tab 3 | Metrics | Surface × utilization metric × health metric |

Fig 3 is the paper's money figure — it should make the thesis legible in ten seconds
to someone who reads nothing else. Draw it first.

---

## 6. What we may and may not claim

**May claim:** the observability gap exists and is structural; push emits no usage
signal while pull does; injected context is irrevocable and current systems do not
model retraction; compaction breaks baselines; staleness is computable against a
commit graph in a way it is not for conversational memory; here is a schema, an
implementation, and an evaluation design.

**May not claim:** that progressive memory improves task success; any token-savings
percentage; that pull-through correlates with outcome quality; that the manifest model
beats excerpts (the baseline measurement has not been run); any generalization beyond
the systems inspected.

**The database currently holds 22 access rows, all `push` at
`session_start_manifest`, and zero pulls.** Do not report a number derived from it.
If a descriptive statistic is wanted, report the schema and the collection status —
"instrumentation deployed; systematic collection is future work" — and nothing more.

---

## 7. Writing plan

Draft in dependency order, not document order. Prose written before the argument is
settled gets thrown away.

| Step | Output | Note |
|---|---|---|
| 1 | Read the three threat papers **in full** | 2607.27250, 2607.17598, 2511.12884. Non-negotiable — these determine what you may claim. |
| 2 | Fig 3 (push vs pull) | If it is not obvious as a picture, the thesis is not yet sharp. |
| 3 | §3 taxonomy | The core. Write it first; everything else is framing or consequence. |
| 4 | §2 background | Version-stamp everything; verify each mechanic against the installed binaries. |
| 5 | §4 + §5 | Compress from the PRD, always re-framed as failure→design. |
| 6 | §6 + §7 | |
| 7 | §1 last | Introductions are written last. Always. |
| 8 | §8, abstract, title | |
| 9 | Reference pass | Every citation verified by opening it. |

### First-paper notes

- **Format.** Use the standard `arxiv` LaTeX style or ACM `sigconf`. Overleaf is the
  path of least resistance. arXiv wants LaTeX source, not PDF-only, and it needs a
  category — this is **cs.SE** primary, **cs.AI** cross-list.
- **Abstract discipline.** 150–200 words: problem, gap, what you did, what you found,
  what it means. No citations, no "in this paper we will."
- **The single most common first-paper failure** is describing your system instead of
  making an argument. Every subsection of §4 must answer "which failure from §3 does
  this address?" If it cannot, it belongs in the repo docs, not the paper.
- **Second most common:** hedging claims you can support and overstating ones you
  cannot. §6 exists to prevent the second.
- **Nobody rejects an arXiv preprint.** You can revise it. Ship v1 rather than
  polishing indefinitely — then use reviewer-style feedback to shape a v2 aimed at a
  venue once evaluation data exists.
- **Authorship and licensing.** Decide the author list now. The repo is Apache-2.0;
  arXiv submissions need a license selection (CC BY 4.0 is the usual choice).

---

## 8. Open questions for the author

1. **Solo or co-authored?** A second author from the Codex-side work would strengthen
   the §2 harness analysis and the empirical claims about binary inspection.
2. **Does the system get named?** Recommendation: name it in §5 and the artifact
   release, not in the title or abstract. A paper that reads as a product announcement
   gets dismissed regardless of merit.
3. **Do we ship the Layer-1 eval before submitting?** It is deterministic and cheap.
   Even one real table would move this from position paper to systems paper. Worth two
   weeks if the corpus can be assembled.
4. **Anonymized data-collection campaign?** Two or three developers over a month would
   give a genuine pull-through number and turn §6 from proposed into reported. This is
   the highest-leverage thing that could change the paper's class.
