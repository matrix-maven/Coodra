# §3 — A Failure Taxonomy for Deployed Agent Memory

Draft 1, 2026-08-19. Target ~1,400 words; current draft runs slightly over and
should be trimmed in revision, not expanded.

Conventions used in this draft:
- `[VERIFY]` marks a claim that must be re-checked against the code before submission.
- `[CITE]` marks a place where a reference is required.
- Each failure is stated as a *mechanism*, then an *instance*, then *what detection
  would require*. Keep that shape; it is what makes the taxonomy usable by others.

---

We derive six failure modes from the operation of a deployed memory layer serving
two production coding agents. They are not ranked by frequency, which we cannot
measure, but by depth: each one undermines the detection of the ones before it.
The last is the most consequential, and the least discussed in prior work.

## 3.1 F1 — Unobservable delivery

**Mechanism.** Context selected for injection is rendered into the prompt and
discarded. The selection is an event with no record: which artifacts were chosen,
in what order, at what byte cost, and against what alternatives are all lost the
moment the string is assembled. The agent's subsequent behaviour is observable;
the input that shaped it is not.

**Instance.** Before instrumentation, our system's session-start path selected
context packs, rendered them, and returned — retaining nothing. `[VERIFY: describe
the pre-instrumentation path precisely; the recorder now exists, so this must be
stated in the past tense with a commit reference.]` The same is true by construction
of static instruction files: a harness that concatenates `CLAUDE.md` or `AGENTS.md`
into a system prompt emits no signal distinguishing a file that was decisive from
one that was ignored. Empirical work mining these files can therefore describe what
developers *write* [CITE: Agent READMEs, arXiv 2511.12884] but not what agents read.

**Detection requires** recording the surfacing itself as a first-class event —
artifact identity, position, byte cost, and the trigger that caused it — at the
moment of injection rather than reconstructing it afterward from a transcript.

## 3.2 F2 — Irrevocability

**Mechanism.** Injection is a one-way write to an append-only transcript. Once
context enters the window it cannot be withdrawn, corrected, or superseded in
place; it can only be contradicted by later text competing for the model's
attention. Filtering superseded material out of *new* injections does nothing about
material already sent.

**Instance.** A session context assembled at hour zero remains verbatim in the
window at hour three, after the approach it describes has been abandoned. Our
prompt-time path queries only active decisions, which correctly excludes a
superseded record from the next injection — and leaves the earlier copy exactly
where it was. `[VERIFY: cite the concatenation path and the activeOnly filter.]`

This is the sharpest asymmetry between file-based and window-based memory, and it
runs opposite to the usual intuition. A file that rots can be corrected and
re-read; the correction propagates on the next read. **A transcript block can be
corrected in the store and remain wrong in the window forever.** File-based memory
is stale until re-read. Injected memory is stale *after* being read, which is worse,
because the model has already conditioned on it.

**Detection requires** knowing what was injected (F1) and comparing it against
current state — that is, treating the window as a cache with no invalidation
protocol, and building one.

## 3.3 F3 — Compaction amnesia

**Mechanism.** Long sessions exceed the window and the harness compacts: summarize,
truncate, continue. Compaction is lossy, and repeated compaction is lossy over the
previous pass's output, so error compounds rather than accumulating linearly.
Grounding injected once at session start degrades to whatever the harness's own
summarizer judged worth preserving — a judgement made without any knowledge of
which spans were externally supplied memory rather than conversation.

**Instance.** Sessions of six hours or more are now routine, and compact several
times. Meanwhile per-prompt injections continue to arrive on top of a baseline that
no longer exists in the form they assume. Deltas are emitted against a state the
model can no longer see.

A harness-level constraint sharpens this. In our implementation, the post-compaction
lifecycle event cannot carry injected context on two of the supported agents, so
re-establishing grounding must ride the *next* user turn rather than the compaction
event itself. `[VERIFY: confirm current behaviour for Claude Code and Devin before
asserting; cite COOD-84.]` The gap between compaction and the next prompt is a
window in which the agent is operating on degraded grounding and nothing knows it.

**Detection requires** a generational marker: an explicit counter incremented at
each compaction, against which "what has this generation already been told" is a
well-formed question. Without it, delta injection is undefined.

## 3.4 F4 — Declared rather than computable freshness

**Mechanism.** Memory systems record supersession when an agent volunteers it.
Nothing verifies that a stored artifact still describes how the system it documents
actually behaves. Supersession ("has this been replaced?") and staleness ("is this
still true?") are distinct properties, and only the first is typically modelled.

**Instance.** Context packs referencing a directory deleted in a refactor remained
retrievable and unmarked; no mechanism knew. `[VERIFY: name the directory and the
change that removed it.]` The failure is not that a stale artifact exists — that is
inevitable — but that the ranker cannot see staleness and will happily place such an
artifact first. **Ranking a stale artifact into position one is worse than retrieving
nothing**, because the agent has no way to discount it and every reason to trust it.

**Detection requires** an external ground truth. This is where coding-agent memory
differs categorically from conversational memory, and the difference is
underexploited. A conversational memory has nothing to rot *against*: whether a
user's stated preference still holds is unknowable from the store. Repository memory
has the commit graph. Recording the commit and the file set an artifact was last
verified against turns "is this still true?" into a mechanical query — have those
files changed since? — rather than a judgement. Benchmarks report that current
memory systems fail conspicuously at selective forgetting [CITE: MemoryAgentBench];
we suggest one reason is that the conversational setting they evaluate offers no
signal to forget *on*.

## 3.5 F5 — Inventory metrics as vanity metrics

**Mechanism.** Deployed memory systems report what they contain: artifacts created,
records written, entries maintained. Every one of these rises when the system
successfully pressures agents to write, and none falls when what was written is
never read again. They would look healthy on a corpus that is entirely noise.

**Instance.** Inspecting one rendered session-start payload in our own repository:
six context packs, 15,529 bytes. Four of the six were auto-generated digests whose
excerpt consisted of 314 bytes of identical boilerplate, a run identifier, and a
truncation mid-word — the same sentence delivered four times, every session. An
inventory dashboard reported six healthy artifacts. Re-rendering the same selection
as an index of identifiers and one-line summaries cost 2,209 bytes, 85.8% less.

We stress what this measurement is not. It is not a token-savings result: bytes
removed from the window are not saved if the agent then retrieves the bodies, and
whether net budget falls is an open question we do not answer. The finding is the
*composition*, not the ratio. And the manner of discovery is the point — **it was
found by a human reading a payload, because no metric in the system was capable of
noticing.**

**Detection requires** pairing every inventory count with a utilization ratio, and
naming the specific failure that inventory cannot see: artifacts surfaced and never
retrieved, and the rarer, costlier case of an artifact surfaced, retrieved, and
contradicted — where retrieval worked and the agent went the other way regardless.
That last case is the only one that distinguishes "we failed to retrieve" from
"retrieval works and nobody listens."

## 3.6 F6 — Silent failure of the measurement layer

**Mechanism.** The instrumentation built to detect F1–F5 is itself unmonitored code
on a hot path, and it fails in a specific and dangerous way: **a broken utilization
metric and a genuinely unused memory produce the same reading.** Zero pulls is what
you observe when agents ignore the memory, and it is also what you observe when the
pull recorder cannot attribute an event. The measurement cannot distinguish its own
failure from the finding it exists to report.

**Instance.** Our pull path resolves a run by session identifier in order to
attribute a retrieval. On the stdio transport the identifier available at the tool
registry is minted by the transport, while the run record stores the identifier
minted by the agent. The two never match. Every recorded pull carried a null run
reference; the cohort rollup, which requires a non-null reference to join a
retrieval to the manifest that surfaced it, therefore admitted none. A dry run of
the rollup over a copy of the production store yielded 33 surfaced artifacts and
zero pulls. `[VERIFY: cite tool-registry.ts line, index.ts line, and the rollup
predicate; state dates.]`

Two details make this more than an anecdote. First, the design document for this
instrumentation *anticipated precisely this hazard*, citing an earlier shipped bug
of the same shape in which an attribution lookup wrote null on every row, and
specified a counter so that attribution loss would itself be observable. The hazard
was named in advance and occurred anyway. Second, the resulting metric was not
absent but *plausible*: zero pull-through is exactly the under-retrieval that the
manifest design predicted as its own most likely failure mode. The instrument
returned a reading that confirmed a hypothesis, and the reading was an artifact of
the instrument.

**Detection requires** treating attribution loss as a monitored quantity rather than
a silent default — a miss must increment a counter, and a metric whose denominator
is healthy while its numerator is structurally zero must be treated as broken until
proven otherwise. More generally, it requires that a memory-utilization system be
able to distinguish *no signal* from *no usage*. We know of no deployed system, our
own included, that currently does.

---

## Drafting notes (delete before submission)

- F6 did not exist in the outline. It emerged from an investigation on 2026-08-19
  and is, in our judgement, the paper's most novel single contribution. Consider
  promoting it into the abstract and §1.
- F2's "stale after being read" formulation is the sharpest sentence in the section;
  make sure §1 does not spend it first.
- F5 must carry the not-a-token-savings caveat *in the same paragraph* as the
  number, not in a later limitations section. Reviewers read numbers out of order.
- Length: F1–F4 are tight; F5 and F6 run long. Trim F6's second paragraph of
  "two details" to one sentence each if the section must fit two columns.
