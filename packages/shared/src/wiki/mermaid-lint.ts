/**
 * `@coodra/shared/wiki` — deterministic structural lint for Mermaid
 * diagrams embedded in wiki page Markdown (Module 10, 2026-07-02).
 *
 * Why this exists: some wiki generation runs produced diagrams the web
 * renderer (`mermaid.render` in `apps/web-v2`) rejects — the page then
 * shows raw diagram source instead of a picture, and the authoring agent
 * never learns it shipped a broken diagram. `wiki_save_page` runs this
 * lint at the MCP boundary and soft-fails with the issues so the agent
 * fixes the diagram BEFORE the page counts as authored.
 *
 * This is a STRUCTURAL lint, not a full Mermaid parser (bundling the
 * ~3 MB browser-oriented `mermaid` package into the mcp-server runtime
 * is not worth the weight and its parser needs a DOM for several diagram
 * types). It deterministically catches the failure classes agents
 * actually produce:
 *   1. empty diagram blocks;
 *   2. an unknown diagram type on the first meaningful line;
 *   3. unbalanced () / [] / {} outside quoted strings;
 *   4. flowchart node labels containing unquoted parens/brackets —
 *      `A[Foo (bar)]` — the single most common agent-authored breakage
 *      (fix: `A["Foo (bar)"]`);
 *   5. unbalanced block keywords: `subgraph`/`end` (flowchart) and
 *      `alt|opt|loop|par|critical|rect|break|box`/`end` (sequence).
 * A diagram passing the lint can still, rarely, fail full parsing — the
 * web render keeps its raw-source fallback for that — but every lint
 * error is a REAL error.
 */

export interface MermaidBlock {
  /** Diagram source without the ```mermaid fences. */
  readonly code: string;
  /** 1-based line of the opening fence in the containing Markdown. */
  readonly fenceLine: number;
}

export interface MermaidLintIssue {
  /** 1-based line within the diagram block. */
  readonly line: number;
  readonly message: string;
}

/** First-word diagram types Mermaid 11 accepts (superset is fine — unknown ones fail loud downstream). */
const DIAGRAM_TYPES = [
  'flowchart',
  'graph',
  'sequencediagram',
  'classdiagram',
  'erdiagram',
  'statediagram',
  'statediagram-v2',
  'journey',
  'gantt',
  'pie',
  'mindmap',
  'timeline',
  'quadrantchart',
  'gitgraph',
  'c4context',
  'c4container',
  'c4component',
  'c4dynamic',
  'c4deployment',
  'requirementdiagram',
  'sankey-beta',
  'xychart-beta',
  'block-beta',
  'packet-beta',
  'architecture-beta',
  'kanban',
  'radar',
  'zenuml',
  'info',
];

/** Extract ```mermaid fenced blocks from Markdown. Tolerates ```mermaid with trailing spaces. */
export function extractMermaidBlocks(markdown: string): MermaidBlock[] {
  const lines = markdown.split('\n');
  const blocks: MermaidBlock[] = [];
  let inBlock = false;
  let fenceLine = 0;
  let buf: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (!inBlock && /^```\s*mermaid\s*$/i.test(trimmed)) {
      inBlock = true;
      fenceLine = i + 1;
      buf = [];
      continue;
    }
    if (inBlock && /^```\s*$/.test(trimmed)) {
      inBlock = false;
      blocks.push({ code: buf.join('\n'), fenceLine });
      continue;
    }
    if (inBlock) buf.push(line);
  }
  // An unclosed ```mermaid fence is itself a structural problem; surface
  // the partial block so the lint reports on it rather than dropping it.
  if (inBlock) blocks.push({ code: buf.join('\n'), fenceLine });
  return blocks;
}

/** Strip `%%` comments and the content of quoted strings (keeps delimiters' balance intact). */
function stripCommentAndQuotes(line: string): string {
  let out = '';
  let quote: '"' | '`' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '%' && line[i + 1] === '%') break; // comment to EOL
    out += ch;
  }
  return out;
}

function firstMeaningfulLine(code: string): { text: string; line: number } | null {
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] ?? '').trim();
    if (t.length === 0) continue;
    if (t.startsWith('%%')) continue; // comment or %%{init}%% directive
    return { text: t, line: i + 1 };
  }
  return null;
}

const FLOWCHART_TYPES = new Set(['flowchart', 'graph']);
const SEQUENCE_BLOCK_OPENERS = /^(alt|opt|loop|par|critical|rect|break|box)\b/;

/**
 * Lint one diagram. Returns [] when structurally sound. Every returned
 * issue is a definite error — the renderer would reject the diagram.
 */
export function lintMermaid(code: string): MermaidLintIssue[] {
  const issues: MermaidLintIssue[] = [];
  const first = firstMeaningfulLine(code);
  if (first === null) {
    return [{ line: 1, message: 'empty mermaid block — write the diagram or drop the fence' }];
  }

  const firstWord = (first.text.split(/[\s;]+/)[0] ?? '').toLowerCase();
  const diagramType = DIAGRAM_TYPES.find((t) => t === firstWord);
  if (diagramType === undefined) {
    issues.push({
      line: first.line,
      message: `unknown diagram type "${first.text.split(/\s+/)[0]}" — the first line must declare one (e.g. flowchart TD, sequenceDiagram, classDiagram, erDiagram)`,
    });
    // Without a known type the remaining checks would guess; stop here.
    return issues;
  }

  const isFlowchart = FLOWCHART_TYPES.has(diagramType);
  const isSequence = diagramType === 'sequencediagram';
  const isEr = diagramType === 'erdiagram';

  const lines = code.split('\n');
  const stack: Array<{ ch: string; line: number }> = [];
  const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let blockDepth = 0; // subgraph/end or alt…/end
  let blockOpenLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let stripped = stripCommentAndQuotes(lines[i] ?? '');
    if (isEr) {
      // ER crow's-foot cardinality tokens (||--o{, }o--||, …) contain lone
      // braces that are connector syntax, not brackets — drop them before
      // balancing.
      stripped = stripped.replace(/\}o|\}\||o\{|\|\{/g, '');
    }
    const trimmed = stripped.trim();

    // Bracket balance (quotes + comments already stripped).
    for (const ch of stripped) {
      if (ch === '(' || ch === '[' || ch === '{') stack.push({ ch, line: lineNo });
      else if (ch === ')' || ch === ']' || ch === '}') {
        const want = PAIRS[ch];
        const top = stack[stack.length - 1];
        if (top !== undefined && top.ch === want) stack.pop();
        else issues.push({ line: lineNo, message: `unbalanced "${ch}" — no matching "${want}" open` });
      }
    }

    // Unquoted parens/brackets inside flowchart node labels — the classic
    // agent breakage: A[uses fn(x)] renders as a parse error. Compound
    // shape delimiters ([(…)], ([…]), [[…]], ((…))) are legal and skipped.
    if (isFlowchart) {
      for (const m of stripped.matchAll(/\[([^\][]*)\]/g)) {
        let inner = m[1] ?? '';
        // Cylinder [(…)] / stadium ([…]) style: the delimiter parens are legal.
        if (inner.startsWith('(') && inner.endsWith(')')) inner = inner.slice(1, -1);
        if (inner.startsWith('"') && inner.endsWith('"')) continue; // quoted label — anything goes
        if (/[()[\]{}]/.test(inner)) {
          issues.push({
            line: lineNo,
            message: `node label "[${m[1]}]" contains unquoted brackets/parens — wrap the label text in double quotes (e.g. A["fn(x)"])`,
          });
        }
      }
    }

    // Block keyword balance.
    if (isFlowchart && /^subgraph\b/.test(trimmed)) {
      blockDepth++;
      blockOpenLine = lineNo;
    } else if (isSequence && SEQUENCE_BLOCK_OPENERS.test(trimmed)) {
      blockDepth++;
      blockOpenLine = lineNo;
    } else if ((isFlowchart || isSequence) && /^end\b/.test(trimmed)) {
      if (blockDepth === 0) {
        issues.push({ line: lineNo, message: '"end" with no open subgraph/block' });
      } else {
        blockDepth--;
      }
    }
  }

  for (const open of stack) {
    issues.push({ line: open.line, message: `unclosed "${open.ch}"` });
  }
  if (blockDepth > 0) {
    issues.push({
      line: blockOpenLine,
      message: `missing "end" — ${blockDepth} block(s) (subgraph/alt/loop/…) never closed`,
    });
  }
  return issues;
}

export interface MarkdownMermaidIssue extends MermaidLintIssue {
  /** 0-based index of the ```mermaid block within the Markdown. */
  readonly blockIndex: number;
  /** 1-based line within the containing Markdown document. */
  readonly markdownLine: number;
}

export interface MarkdownMermaidLintResult {
  /** Number of ```mermaid blocks found. */
  readonly blockCount: number;
  readonly issues: MarkdownMermaidIssue[];
}

/** Lint every ```mermaid block in a Markdown document. */
export function lintMarkdownMermaid(markdown: string): MarkdownMermaidLintResult {
  const blocks = extractMermaidBlocks(markdown);
  const issues: MarkdownMermaidIssue[] = [];
  blocks.forEach((block, blockIndex) => {
    for (const issue of lintMermaid(block.code)) {
      issues.push({ ...issue, blockIndex, markdownLine: block.fenceLine + issue.line });
    }
  });
  return { blockCount: blocks.length, issues };
}
