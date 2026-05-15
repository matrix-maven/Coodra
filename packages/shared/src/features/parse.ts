import { parse as parseYaml } from 'yaml';

import { FRONTMATTER_SCHEMA, validateFrontmatterQuality } from './schema.js';
import type { ParsedFeatureMd } from './types.js';

/**
 * @coodra/shared/features — feature.md parser.
 *
 * The format mirrors the de-facto standard for skill / index files
 * (Anthropic Skills, Jekyll, Hugo, MkDocs Material): a `---`-delimited
 * YAML block at the top of the file followed by a free-form markdown
 * body. Example:
 *
 *     ---
 *     name: payments-flow
 *     description: |
 *       Use this whenever the user is working on Stripe integration —
 *       charges, refunds, payment failures, webhook signing.
 *     maturity: stable
 *     ---
 *
 *     # Payments flow
 *
 *     The body is whatever the author wants — markdown, code blocks, etc.
 *
 * Failure modes that the parser distinguishes (all returned as structured
 * `errors`, never thrown):
 *
 *   - missing leading `---` line          → `frontmatter_missing_open_fence`
 *   - never-closed frontmatter block      → `frontmatter_missing_close_fence`
 *   - YAML inside the block doesn't parse → `frontmatter_yaml_parse_failed: <msg>`
 *   - YAML parses but Zod rejects shape   → `frontmatter_invalid: <issue path: msg>`
 *
 * The parser is content-only — it never touches the filesystem. Callers
 * (`walk.ts`) read bytes off disk and hand them in.
 */

/** Length cap on the frontmatter block. 32KB is plenty; rejects abusive input. */
const MAX_FRONTMATTER_BYTES = 32 * 1024;

/**
 * Parse a feature.md file's contents into structured frontmatter +
 * body. Always returns a `ParsedFeatureMd`; never throws.
 *
 * Encoding: input is expected to be UTF-8 already decoded into a JS
 * string by the caller. CRLF newlines are tolerated (we test for
 * `\r?\n`).
 */
export function parseFeatureMd(raw: string): ParsedFeatureMd {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Strip an optional leading BOM — some editors add it on save and it
  // would otherwise break the `---` opening fence detection.
  const content = raw.replace(/^﻿/, '');

  // Split frontmatter from body. The opening fence MUST be on the
  // first line (after optional BOM, no whitespace allowed before it).
  // The closing fence is the first subsequent line that consists
  // entirely of three dashes (with optional trailing whitespace).
  const fenceRe = /^---[ \t]*\r?\n/;
  const fenceMatch = content.match(fenceRe);
  if (fenceMatch === null) {
    errors.push(
      'frontmatter_missing_open_fence: feature.md must start with a YAML frontmatter block delimited by "---" lines',
    );
    return { frontmatter: null, body: content, errors, warnings };
  }
  const afterOpen = content.slice(fenceMatch[0].length);
  const closeRe = /\r?\n---[ \t]*(\r?\n|$)/;
  const closeMatch = afterOpen.match(closeRe);
  if (closeMatch === null || closeMatch.index === undefined) {
    errors.push('frontmatter_missing_close_fence: opened YAML frontmatter is never closed by a "---" line');
    return { frontmatter: null, body: content, errors, warnings };
  }
  const yamlBlock = afterOpen.slice(0, closeMatch.index);
  if (yamlBlock.length > MAX_FRONTMATTER_BYTES) {
    errors.push(`frontmatter_too_large: ${yamlBlock.length} bytes exceeds the ${MAX_FRONTMATTER_BYTES} byte cap`);
    return { frontmatter: null, body: '', errors, warnings };
  }
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);

  // Parse the YAML block. The `yaml` package throws on bad input; we
  // translate to a structured error.
  let yamlValue: unknown;
  try {
    yamlValue = parseYaml(yamlBlock);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`frontmatter_yaml_parse_failed: ${msg}`);
    return { frontmatter: null, body, errors, warnings };
  }
  if (yamlValue === null || typeof yamlValue !== 'object' || Array.isArray(yamlValue)) {
    errors.push('frontmatter_yaml_not_object: frontmatter must be a YAML mapping (key/value pairs)');
    return { frontmatter: null, body, errors, warnings };
  }

  // Normalise — accept both snake_case (`when_not_to_use`) AND
  // camelCase (`whenNotToUse`) so authors who came from other tools
  // don't get tripped up. Canonicalise to camelCase for Zod.
  const normalised = normaliseKeys(yamlValue as Record<string, unknown>);
  const parsed = FRONTMATTER_SCHEMA.safeParse(normalised);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      errors.push(`frontmatter_invalid: ${path}: ${issue.message}`);
    }
    return { frontmatter: null, body, errors, warnings };
  }

  warnings.push(...validateFrontmatterQuality(parsed.data));
  return { frontmatter: parsed.data, body, errors, warnings };
}

/**
 * Convert known snake_case frontmatter keys to camelCase. Conservative
 * — only applies to fields that exist in the schema. Unknown keys
 * pass through unchanged so future fields and user-defined extensions
 * keep working.
 */
function normaliseKeys(input: Record<string, unknown>): Record<string, unknown> {
  const aliasMap: Record<string, string> = {
    when_not_to_use: 'whenNotToUse',
    whennottouse: 'whenNotToUse',
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const canonical = aliasMap[key.toLowerCase()] ?? key;
    out[canonical] = value;
  }
  return out;
}

/**
 * Render a feature.md file from structured frontmatter + body. Inverse
 * of `parseFeatureMd` — used by the CLI's `feature add` and the web
 * editor's save action so file shape stays canonical regardless of
 * which surface authored it.
 *
 * The frontmatter is emitted as a deterministic key order so two
 * identical inputs produce byte-identical files (matters for git
 * diffs and idempotency tests).
 */
export function renderFeatureMd(args: {
  readonly frontmatter: {
    readonly name: string;
    readonly description: string;
    readonly whenNotToUse?: string;
    readonly maturity?: 'draft' | 'beta' | 'stable' | 'deprecated';
    readonly owners?: ReadonlyArray<string>;
    readonly tags?: ReadonlyArray<string>;
  };
  readonly body: string;
}): string {
  const { frontmatter: fm, body } = args;
  const lines: string[] = ['---'];
  lines.push(`name: ${escapeYamlScalar(fm.name)}`);
  lines.push(...renderMaybeMultiline('description', fm.description));
  if (fm.whenNotToUse !== undefined && fm.whenNotToUse.length > 0) {
    lines.push(...renderMaybeMultiline('whenNotToUse', fm.whenNotToUse));
  }
  if (fm.maturity !== undefined) {
    lines.push(`maturity: ${fm.maturity}`);
  }
  if (fm.owners !== undefined && fm.owners.length > 0) {
    lines.push(`owners: [${fm.owners.map(escapeYamlScalar).join(', ')}]`);
  }
  if (fm.tags !== undefined && fm.tags.length > 0) {
    lines.push(`tags: [${fm.tags.map(escapeYamlScalar).join(', ')}]`);
  }
  lines.push('---');
  // Ensure exactly one blank line between frontmatter and body for
  // readability; trim leading newlines on body so re-rendering is
  // idempotent (we don't accumulate blank lines on round-trip).
  const trimmedBody = body.replace(/^\r?\n+/, '');
  return `${lines.join('\n')}\n\n${trimmedBody}${trimmedBody.endsWith('\n') ? '' : '\n'}`;
}

function renderMaybeMultiline(key: string, value: string): string[] {
  // Use block-scalar style for any value that contains a newline OR is
  // long enough that quoting becomes ugly. Otherwise emit a quoted scalar.
  if (value.includes('\n') || value.length > 80) {
    const indented = value
      .split(/\r?\n/)
      .map((line) => `  ${line}`)
      .join('\n');
    return [`${key}: |`, indented];
  }
  return [`${key}: ${escapeYamlScalar(value)}`];
}

/**
 * Conservative YAML scalar escape. Quotes the string when it contains
 * any character that would change YAML parsing (colons, hashes,
 * brackets, leading whitespace, indicators). Otherwise emits the bare
 * string. Single-quote style is used because embedded `'` is rare in
 * our domain (slugs, descriptions, tags) and the doubling escape rule
 * is simple.
 */
function escapeYamlScalar(value: string): string {
  if (value.length === 0) return "''";
  // Bare-string is safe when:
  //   - first char is alnum or hyphen/underscore
  //   - no YAML indicators inside (`:`, `#`, `[`, `]`, `{`, `}`, `,`, `&`, `*`, `!`, `|`, `>`, `'`, `"`, `%`, `@`, ` `)
  //   - not entirely numeric / boolean-like
  const safeRe = /^[A-Za-z0-9_][A-Za-z0-9_\-./@]*$/;
  const reservedRe = /^(true|false|null|yes|no|on|off|~)$/i;
  if (safeRe.test(value) && !reservedRe.test(value) && !/^-?\d+(\.\d+)?$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "''")}'`;
}
