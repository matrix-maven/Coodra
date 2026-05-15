import type { RunWithEverything } from '@coodra/db';

import { renderMarkdown } from './render-markdown.js';

/**
 * `lib/export/render-html` — wraps the markdown renderer's output in a
 * self-contained HTML document with embedded CSS. Single-file
 * artifact — no external assets, no JS. Suitable for pasting into a
 * pull-request comment, attaching to a Linear ticket, or just
 * forwarding via email.
 *
 * The markdown → HTML conversion is intentionally minimal (no full
 * CommonMark): headers, bold, inline code, blockquote `<sub>` tags
 * (passes through verbatim), tables, and bullet lists. We pass the
 * markdown through a simple line-by-line transform; this keeps the
 * dep surface zero and gives operators a predictable rendering they
 * can grok at a glance.
 */

export interface RenderHtmlOptions {
  readonly includeAudit: boolean;
}

const STYLES = `
:root { --fg: #1f2937; --muted: #6b7280; --bg: #f9fafb; --code-bg: #f3f4f6; --border: #e5e7eb; --accent: #2563eb; }
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem; max-width: 56rem; margin-inline: auto;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: var(--fg); background: var(--bg); line-height: 1.6; }
h1, h2, h3 { color: var(--fg); border-bottom: 1px solid var(--border); padding-bottom: 0.25rem; }
h1 { font-size: 1.75rem; }
h2 { font-size: 1.4rem; margin-top: 2rem; }
h3 { font-size: 1.15rem; margin-top: 1.5rem; }
code { background: var(--code-bg); padding: 0.1rem 0.35rem; border-radius: 3px;
  font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 0.95em; }
table { border-collapse: collapse; width: 100%; margin: 0.75rem 0; font-size: 0.9rem; }
th, td { padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
th { background: var(--code-bg); }
sub { color: var(--muted); font-size: 0.85em; }
ul { padding-left: 1.5rem; }
em { color: var(--muted); font-style: normal; }
.deny { color: #b91c1c; font-weight: 600; }
.allow { color: #15803d; font-weight: 600; }
.ask { color: #b45309; font-weight: 600; }
`.trim();

export function renderHtml(data: RunWithEverything, options: RenderHtmlOptions): string {
  const md = renderMarkdown(data, options);
  const body = markdownToHtml(md);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    `  <title>coodra run ${escapeHtml(data.run.id)}</title>`,
    `  <style>${STYLES}</style>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

interface TableState {
  inTable: boolean;
  headerEmitted: boolean;
}

function markdownToHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  const tableState: TableState = { inTable: false, headerEmitted: false };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = raw.trimEnd();

    // Tables.
    if (line.startsWith('|') && line.endsWith('|')) {
      if (/^\|\s*-+\s*(\|\s*-+\s*)+\|$/.test(line)) {
        tableState.headerEmitted = true;
        continue;
      }
      if (!tableState.inTable) {
        out.push('<table>');
        tableState.inTable = true;
        tableState.headerEmitted = false;
      }
      const cells = line
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      const tag = tableState.headerEmitted ? 'td' : 'th';
      out.push(`<tr>${cells.map((c) => `<${tag}>${renderInline(c)}</${tag}>`).join('')}</tr>`);
      continue;
    }
    if (tableState.inTable) {
      out.push('</table>');
      tableState.inTable = false;
      tableState.headerEmitted = false;
    }

    if (line.length === 0) {
      out.push('');
      continue;
    }
    if (line.startsWith('# ')) {
      out.push(`<h1>${renderInline(line.slice(2))}</h1>`);
      continue;
    }
    if (line.startsWith('## ')) {
      out.push(`<h2>${renderInline(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith('### ')) {
      out.push(`<h3>${renderInline(line.slice(4))}</h3>`);
      continue;
    }
    if (line.startsWith('- ')) {
      out.push(`<li>${renderInline(line.slice(2))}</li>`);
      continue;
    }
    out.push(`<p>${renderInline(line)}</p>`);
  }
  if (tableState.inTable) out.push('</table>');

  // Wrap consecutive <li> blocks into <ul>.
  const wrapped: string[] = [];
  let inList = false;
  for (const l of out) {
    if (l.startsWith('<li>')) {
      if (!inList) {
        wrapped.push('<ul>');
        inList = true;
      }
      wrapped.push(l);
    } else {
      if (inList) {
        wrapped.push('</ul>');
        inList = false;
      }
      wrapped.push(l);
    }
  }
  if (inList) wrapped.push('</ul>');

  return wrapped.join('\n');
}

function renderInline(s: string): string {
  // Convert code spans first so ** inside ``...`` stays literal. Use a
  // multi-character sentinel that won't legally appear in operator-supplied
  // markdown to placehold the rendered tokens, then re-substitute after
  // the bold/italic transforms.
  const codeMarkers: string[] = [];
  const withoutCode = s.replace(/`([^`]+)`/g, (_match, p1: string) => {
    codeMarkers.push(`<code>${escapeHtml(p1)}</code>`);
    return `__CTX_CODE_${codeMarkers.length - 1}__`;
  });
  let result = escapeHtml(withoutCode);
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/_([^_]+)_/g, '<em>$1</em>');
  result = result.replace(/__CTX_CODE_(\d+)__/g, (_match, idx: string) => codeMarkers[Number(idx)] ?? '');
  // Decision-color highlights for table cells.
  result = result.replace(/(^|>)deny(<|$)/gi, '$1<span class="deny">deny</span>$2');
  result = result.replace(/(^|>)allow(<|$)/gi, '$1<span class="allow">allow</span>$2');
  result = result.replace(/(^|>)ask(<|$)/gi, '$1<span class="ask">ask</span>$2');
  return result;
}
