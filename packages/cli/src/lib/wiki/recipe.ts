import type { WikiMode } from '@coodra/shared/wiki';

/**
 * `lib/wiki/recipe.ts` — the Deep Wiki authoring recipe (Module 10).
 *
 * Coodra runs no LLM. The user's coding agent (Claude Code / Codex /
 * Cursor) is the model. `coodra wiki generate` writes this recipe so the
 * agent knows exactly how to run the DeepWiki-style two-pass flow against
 * Coodra's MCP tools:
 *
 *   PASS 1 — plan a hierarchical WikiStructure from the grounding bundle,
 *            persist via `wiki_save_structure`.
 *   PASS 2 — author each pending page's Markdown (with Mermaid + code
 *            citations) via `wiki_save_page`; resume via `wiki_status`.
 *
 * The same recipe text backs both the per-run `.coodra/wiki-job.md`
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
      ? `Coverage target (comprehensive mode): derive the page count from the
REPO, not from a default number. Rule of thumb — one page per major
module / service / package in the grounding's directory rollup (and per
Graphify community cluster when the graph is wired), PLUS Overview,
Architecture, Configuration, Data Model, Testing, and
Operations/Deployment pages where the code warrants them. A real codebase
typically lands at 12–30 pages; **under-covering is the common failure
mode — when in doubt, ADD the page.** Group pages into sections so the
result reads like a hierarchical mind-map (Overview → Architecture →
per-module pages → Operations), not a flat dump.`
      : `Coverage target (concise mode): 6–12 focused pages, flat
(\`sections: []\`). Cover Overview, Architecture, the 3–6 most important
modules, and Operations. Depth over breadth — but never merge two
unrelated subsystems into one page.`;

  return `Plan a \`WikiStructure\` (this exact shape — Coodra validates it):

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
 * per-run slug/mode/grounding header (used for `.coodra/wiki-job.md`);
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
    lines.push('');
    lines.push(
      'You (the coding agent) generate this wiki. Coodra runs no model — you are the model; Coodra stores the result and renders it in its web app. Follow the two passes below exactly.',
    );
    lines.push('');
  }

  lines.push('## ⚠ Critical — the ONLY way this works');
  lines.push('');
  lines.push(
    "The wiki exists **only** in Coodra's store, written through the MCP tools. **Do NOT create files** — no `DEEP_WIKI.md`, no `WIKI_INDEX.md`, no `.coodra/wiki-structure.json`, no `docs/wiki/*`. Writing Markdown/JSON to disk does **nothing**: it will NOT appear in `coodra wiki status` or the `/wiki` web page. The only things that count are these MCP calls:",
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
    `2. Read \`${groundingPath}\` — the bounded codebase snapshot (stack, directory rollup, file list, README, Graphify summary). If its file list is marked truncated ("N+, sample capped"), enumerate the under-represented directories yourself before planning — the wiki must cover the REPO, not the sample.`,
  );
  lines.push(
    '3. If the `graphify` MCP server is wired, call its `query_graph` / `get_neighbors` to ground the structure in the real dependency graph (communities → sections; high-degree nodes → important pages).',
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
      'Use this when the user asks to generate, build, refresh, or update the Deep Wiki / codebase wiki / architecture docs for this project (e.g. "generate the deep wiki", "build the wiki", "document the architecture"). Drives the two-pass DeepWiki flow: plan a hierarchical WikiStructure, then author each page (Markdown + Mermaid) via Coodra’s wiki_save_structure / wiki_save_page / wiki_status MCP tools, reading the latest job at .coodra/wiki-job.md.',
    whenNotToUse:
      'Don’t use for editing a single existing doc, for Feature Packs (module blueprints), or for Context Packs (session recaps). Those are separate surfaces.',
    maturity: 'stable',
  };
}

/** The `deep-wiki-author` Feature body — the stable recipe, pointing at the per-run job. */
export function renderDeepWikiFeatureBody(): string {
  const recipe = renderWikiRecipe({
    projectSlug: '<this project>',
    slug: '<see .coodra/wiki-job.md>',
    mode: 'comprehensive',
    groundingPath: '.coodra/wiki-grounding.md',
    includeJobHeader: false,
  });
  return [
    '# deep-wiki-author',
    '',
    'Generate a DeepWiki-style, hierarchical/mind-map explanation of this codebase. **You are the model** — Coodra stores the result and renders it in its web app; it runs no LLM of its own.',
    '',
    'The user runs `coodra wiki generate` first, which writes the per-run job (`.coodra/wiki-job.md` — read it for the exact `slug` and `mode`) and the grounding snapshot (`.coodra/wiki-grounding.md`). Then follow the recipe below.',
    '',
    recipe.trimEnd(),
    '',
  ].join('\n');
}
