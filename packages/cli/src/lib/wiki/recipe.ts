import type { WikiMode } from '@coodra/shared/wiki';

/**
 * `lib/wiki/recipe.ts` — the Deep Wiki authoring recipe (Module 10).
 *
 * Coodra runs no LLM. The user's coding agent (Claude Code / Codex /
 * Cursor) is the model. `coodra wiki build` writes this recipe so the
 * agent knows exactly how to run the DeepWiki-style two-pass flow against
 * Coodra's MCP tools:
 *
 *   PASS 1 — plan a hierarchical WikiStructure from the grounding bundle,
 *            persist via `wiki_save_structure`.
 *   PASS 2 — author each pending page's Markdown (with Mermaid + code
 *            citations) via `wiki_save_page`; resume via `wiki_status`.
 *
 * The same recipe text backs both the per-run `.coodra/wiki/job.md`
 * (self-contained, read by any agent) and the bundled `deep-wiki-author`
 * Feature (pulled on trigger when the user asks to "generate the wiki").
 */

export interface WikiJobDescriptor {
  readonly v: 1;
  readonly projectSlug: string;
  readonly slug: string;
  readonly mode: WikiMode;
  /** Repo-root-relative path to the grounding bundle. */
  readonly groundingPath: string;
}

export function buildWikiJob(args: {
  readonly projectSlug: string;
  readonly slug: string;
  readonly mode: WikiMode;
  readonly groundingPath: string;
}): WikiJobDescriptor {
  return { v: 1, projectSlug: args.projectSlug, slug: args.slug, mode: args.mode, groundingPath: args.groundingPath };
}

function structureBlock(mode: WikiMode): string {
  const coverageTarget =
    mode === 'comprehensive'
      ? `Coverage target (comprehensive mode): build the smallest structure that
accurately explains THIS REPO, and let the repo earn every section/page. A real
codebase often lands around 12–30 pages, but that is a range, not a target:
small focused repos may need fewer; broad monorepos/platforms may need more.
**Under-covering is the common failure mode — when in doubt, ADD the page or
record the deferred area in a page description.**`
      : `Coverage target (concise mode): derive 6–12 focused pages from THIS
REPO's actual domains/workflows, with \`sections: []\`. Cover the most important
user/developer workflows and modules; do not force generic Overview /
Architecture / Configuration headings when the repo calls for a different
shape. Depth over breadth — but never merge two unrelated subsystems into one
page.`;

  return `Before constructing JSON, make an OpenWiki-style discovery plan. Do
not write the plan to disk; encode it into the \`WikiStructure\` you save.

Discovery plan checklist:

1. Identify the repo shape from evidence, not from a canned taxonomy. Inspect
   the grounding's README, manifests, directory rollup, entrypoints, routing
   files, schema/model files, tests, deployment/config files, existing docs,
   Graphify communities, god nodes, and prior Coodra decisions/context.
2. List the major domains/workflows/subsystems the repo actually has. Include
   both technical domains and product/business workflows when the source shows
   them.
3. For each candidate page, write down: purpose, source evidence, important
   relationships to other concepts, and whether a diagram would clarify the
   runtime/data/control flow.
4. Model relationships before page creation: source concept -> relationship
   meaning -> target concept. Turn those into \`relatedPageIds\` and meaningful
   prose links later; do not add links solely for graph density.
5. Decide section boundaries only after the page candidates exist. A section
   must represent a real documentation area, not a generic bucket.

Section/page quality rules:

- Do NOT use a fixed Coodra/SaaS/OpenWiki/DeepWiki template. Generic labels
  such as Overview, Architecture, Configuration, Data Model, Integrations,
  Testing, and Operations are allowed only when this repository earns them.
- Prefer broader pages with headings over thin pages. If a page would be mostly
  a stub, source map, or short note, merge it into a broader page.
- A section should usually contain multiple substantive pages. A single-page
  section is acceptable only when that page has a strong domain boundary and is
  likely to grow.
- Every substantive page should connect to at least one other substantive page
  through \`parentId\` or \`relatedPageIds\`; if it is isolated, merge it or make
  the standalone reason explicit in its description.
- Cross-check the directory rollup against Graphify communities. Communities are
  candidate domains, not automatic pages. God nodes deserve high-importance
  pages only when they are real architectural centers.

Plan a \`WikiStructure\` (this exact shape — Coodra validates it):

\`\`\`jsonc
{
  "schemaVersion": 1,
  "title": "<project> — a one-line title",
  "description": "<2–4 sentence overview of what this codebase is>",
  "mode": "${mode}",            // "comprehensive" = sections+pages; "concise" = flat pages
  "sections": [                          // [] when mode is "concise"
    { "id": "overview", "title": "Overview", "pageIds": ["introduction"], "subsectionIds": ["architecture"] }
  ],
  "pages": [
    {
      "id": "introduction",             // kebab-case, unique, stable
      "title": "Introduction",
      "description": "One paragraph: what this page covers and why it matters.",
      "importance": "high",             // high | medium | low
      "parentId": null,                  // a page id, or null for a top-level page → builds the mind-map
      "relevantFiles": ["README.md", "src/index.ts"],   // the files this page explains
      "relatedPageIds": ["architecture"],
      "wantsDiagram": true,              // true → pass 2 MUST include a Mermaid diagram on this page
      "graphCommunityId": 0              // optional: the Graphify community id, if you used the graph
    }
  ]
}
\`\`\`

Rules that Coodra enforces (a violation is rejected): every \`parentId\` /
\`relatedPageIds\` / section \`pageIds\` / \`subsectionIds\` must reference an
id that exists; page ids are unique; ≥ 1 page.

${coverageTarget}`;
}

/**
 * Render the full authoring recipe. `includeJobHeader` adds the
 * per-run slug/mode/grounding header (used for `.coodra/wiki/job.md`);
 * the Feature body omits it and tells the agent to read the job file.
 */
export function renderWikiRecipe(args: {
  readonly projectSlug: string;
  readonly slug: string;
  readonly mode: WikiMode;
  readonly groundingPath: string;
  readonly includeJobHeader: boolean;
}): string {
  const { projectSlug, slug, mode, groundingPath, includeJobHeader } = args;
  const lines: string[] = [];

  if (includeJobHeader) {
    lines.push(`# Deep Wiki job — ${projectSlug}`);
    lines.push('');
    lines.push('| field | value |');
    lines.push('| --- | --- |');
    lines.push(`| project | \`${projectSlug}\` |`);
    lines.push(`| wiki slug | \`${slug}\` |`);
    lines.push(`| mode | \`${mode}\` |`);
    lines.push(`| grounding | \`${groundingPath}\` |`);
    lines.push(`| markdown mirror | \`.coodra/wiki/${slug}/\` |`);
    lines.push('');
    lines.push(
      'You (the coding agent) generate this wiki. Coodra runs no model — you are the model; Coodra stores the result and renders it in its web app. Follow the two passes below exactly.',
    );
    lines.push('');
  }

  lines.push('## ⚠ Critical — source of truth + Markdown mirror');
  lines.push('');
  lines.push(
    `The canonical wiki exists in Coodra's store, written through the MCP tools. Also maintain a repo-local Markdown mirror under \`.coodra/wiki/${slug}/\` for review, portability, and OKF export. Do NOT write root-level \`DEEP_WIKI.md\`, \`WIKI_INDEX.md\`, \`.coodra/wiki-structure.json\`, \`docs/wiki/*\`, or \`openwiki/\` output. Files are useful as a mirror only; the MCP saves are what make \`coodra wiki status\` and \`/wiki\` work.`,
  );
  lines.push('');
  lines.push('- `coodra__get_run_id`  → bind a run');
  lines.push('- `coodra__wiki_save_structure`  → save the plan (pass 1)');
  lines.push('- `coodra__wiki_save_page`  → save each page (pass 2)');
  lines.push('- `coodra__wiki_status`  → check progress');
  lines.push('');
  lines.push(
    '**Preflight:** confirm `coodra__wiki_save_structure` is in your available tools. If it is NOT listed, STOP and tell the user: *“Restart the Coodra MCP server (`coodra stop && coodra start`) and reconnect this agent (e.g. `/mcp` in Claude Code), then ask me again — the wiki tools shipped in CLI 0.2.0-beta.21.”* Do not fall back to writing files.',
  );
  lines.push('');

  lines.push('## Pass 0 — bind a run');
  lines.push('');
  lines.push(`1. Call \`coodra__get_run_id({ projectSlug: "${projectSlug}" })\` and keep the \`runId\`.`);
  lines.push(
    `2. Read \`${groundingPath}\` — the bounded codebase snapshot. It now carries real structure, not just a file list: **stack, directory rollup, file list, README, the Graphify graph (largest communities + god nodes + GRAPH_REPORT.md excerpt), and "Prior recorded work" (this project's own decisions + context packs)**. Use every section:`,
  );
  lines.push(
    '   - **Graphify communities → candidate sections**, **god nodes → candidate `importance: "high"` pages** — the grounding already lists them. Map communities onto real modules; do NOT mint one page per community (ADR-015).',
  );
  lines.push(
    '   - **Prior recorded work → the architecture that was actually decided.** When the grounding lists a decision with a rationale, the wiki must EXPLAIN that architecture (and cite the reason), not re-derive a different one from the code and contradict it. Pull a full recap with `coodra__read_context_pack` / `coodra__search_packs_nl` when a pack looks load-bearing.',
  );
  lines.push(
    '   - If the file list is marked truncated ("N+, sample capped"), enumerate the under-represented directories yourself before planning — the wiki must cover the REPO, not the sample.',
  );
  lines.push(
    '3. If the `graphify` MCP server is wired, call its `query_graph` / `get_neighbors` / `shortest_path` for neighbours and dependency paths the grounding summary doesn’t already give you.',
  );
  lines.push('');

  lines.push('## Pass 1 — plan + save the structure');
  lines.push('');
  lines.push(structureBlock(mode));
  lines.push('');
  lines.push(
    `Then persist it: \`coodra__wiki_save_structure({ runId, slug: "${slug}", structure })\`. It returns \`{ wikiId, pendingPageIds, pageCount }\`. **Keep the \`wikiId\`** — every later call needs it. If a wiki with AUTHORED pages already exists under this slug, the call soft-fails with \`wiki_exists\` — deliberately, so one agent cannot silently wipe another's authored wiki. Re-call with \`replace: true\` ONLY when the user explicitly asked for a re-plan/refresh; otherwise pick a different slug or resume the existing wiki via \`wiki_status\`.`,
  );
  lines.push('');
  lines.push(
    `After \`wiki_save_structure\` succeeds, mirror the exact structure JSON to \`.coodra/wiki/${slug}/structure.json\`. This mirror must match the saved structure; do not create it before the MCP save succeeds.`,
  );
  lines.push('');

  lines.push('## Pass 2 — author every page');
  lines.push('');
  lines.push('For each id in `pendingPageIds`:');
  lines.push('');
  lines.push("1. Read that page's `relevantFiles` (and follow imports/neighbours as needed).");
  lines.push(
    '2. Write the page body as Markdown: a clear explanation, real code excerpts with file references, and — when `wantsDiagram` is true — at least one ```mermaid diagram (flowchart, sequence, or class/ER) that actually reflects the code.',
  );
  lines.push('3. Persist it:');
  lines.push('');
  lines.push('```js');
  lines.push('coodra__wiki_save_page({');
  lines.push('  runId, wikiId,');
  lines.push('  pageId: "<this page id>",');
  lines.push('  content: {');
  lines.push('    contentMarkdown: "<the full page markdown, including any ```mermaid blocks>",');
  lines.push('    citations: [ { file: "src/foo.ts", startLine: 10, endLine: 42 } ]   // optional');
  lines.push('  }');
  lines.push('})');
  lines.push('```');
  lines.push('');
  lines.push(
    `4. After \`wiki_save_page\` returns \`ok: true\`, mirror the exact Markdown body to \`.coodra/wiki/${slug}/<pageId>.md\`. Include a short frontmatter block with \`pageId\`, \`wikiId\`, \`title\`, \`state: authored\`, and \`updatedAt\`, then the same Markdown sent to the MCP tool. Do not write or update the mirror file when the MCP save returns an error.`,
  );
  lines.push('');
  lines.push('### Mermaid rules — the server lint-gates every diagram');
  lines.push('');
  lines.push(
    '`wiki_save_page` structurally lints every ```mermaid block BEFORE accepting the page. A broken diagram returns `{ ok: false, error: "invalid_mermaid", issues: [...] }` — fix each listed line and re-call. A `wantsDiagram: true` page with no ```mermaid block returns `diagram_missing`. To pass first time:',
  );
  lines.push('');
  lines.push(
    '- Declare the diagram type on the FIRST line: `flowchart TD`, `sequenceDiagram`, `classDiagram`, `erDiagram`, …',
  );
  lines.push(
    '- Wrap any flowchart label containing parentheses/brackets in double quotes: `A["calls fn(x)"]` — never `A[calls fn(x)]` (the #1 render breakage).',
  );
  lines.push('- Close every `subgraph` / `alt` / `opt` / `loop` / `par` with `end`; keep (), [], {} balanced.');
  lines.push(
    '- One diagram per fenced block; keep node ids simple (letters/digits/underscores), put prose in the quoted label.',
  );
  lines.push(
    '- Re-read your diagram line by line before saving — the lint catches structure, but only YOU can make it truthful to the code.',
  );
  lines.push('');
  lines.push(
    'Work one page at a time for stability. Call `coodra__wiki_status({ wikiId })` whenever you need to see what is still pending (e.g. after an interruption — you can resume in a later session without re-planning).',
  );
  lines.push('');

  lines.push('## Done');
  lines.push('');
  lines.push(
    'When `wiki_status` shows `pendingCount: 0`, the wiki is complete. Tell the user to view it: `coodra wiki open` (or open `/wiki` in the Coodra web app). The wiki renders as a hierarchical mind-map with your Markdown + Mermaid diagrams.',
  );
  lines.push('');
  lines.push(
    'Quality bar: a good page teaches — it names the key types/functions, shows how data flows, and links related pages. Make each page deep AND keep coverage: when two subsystems crowd one page, SPLIT them into two pages rather than shallow-merging — never shrink the page count at the cost of an uncovered module. Ground every claim in a file you actually read.',
  );
  lines.push('');

  return `${lines.join('\n')}\n`;
}

/** The `deep-wiki-author` Feature frontmatter (pulled on trigger). */
export function deepWikiFeatureFrontmatter(): {
  readonly name: string;
  readonly description: string;
  readonly whenNotToUse: string;
  readonly maturity: 'stable';
} {
  return {
    name: 'deep-wiki-author',
    description:
      'Use this when the user asks to generate, build, refresh, or update the Deep Wiki / codebase wiki / architecture docs for this project (e.g. "generate the deep wiki", "build the wiki", "document the architecture"). Drives the two-pass Coodra Wiki flow: plan a hierarchical WikiStructure, then author each page (Markdown + Mermaid) via Coodra’s wiki_save_structure / wiki_save_page / wiki_status MCP tools, reading the latest job at .coodra/wiki/job.md.',
    whenNotToUse:
      'Don’t use for editing a single existing doc, for Feature Packs (module blueprints), or for Context Packs (session recaps). Those are separate surfaces.',
    maturity: 'stable',
  };
}

/** The `deep-wiki-author` Feature body — the stable recipe, pointing at the per-run job. */
export function renderDeepWikiFeatureBody(): string {
  const recipe = renderWikiRecipe({
    projectSlug: '<this project>',
    slug: '<see .coodra/wiki/job.md>',
    mode: 'comprehensive',
    groundingPath: '.coodra/wiki/grounding.md',
    includeJobHeader: false,
  });
  return [
    '# deep-wiki-author',
    '',
    'Generate a DeepWiki-style, hierarchical/mind-map explanation of this codebase. **You are the model** — Coodra stores the result and renders it in its web app; it runs no LLM of its own.',
    '',
    'The user runs `coodra wiki build` first, which writes the per-run job (`.coodra/wiki/job.md` — read it for the exact `slug` and `mode`) and the grounding snapshot (`.coodra/wiki/grounding.md`). `coodra wiki generate` is a deprecated alias. Then follow the recipe below.',
    '',
    recipe.trimEnd(),
    '',
  ].join('\n');
}
