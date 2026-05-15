/**
 * Assertion helpers for MCP tool manifests.
 *
 * These assertions pin the `system-architecture.md` §24.3 description
 * contract — the "Tool descriptions are agent prompts" discipline
 * that makes `tools/list` output agent-directable without a human in
 * the loop. Every tool manifest that lands in the Coodra monorepo
 * (the eight `coodra__*` tools in Module 02, any future tool in
 * downstream packages) should route its manifest test through
 * `assertManifestDescriptionValid` so the §24.3 rules stay uniform
 * across packages and cannot drift per-tool.
 *
 * Consumed from:
 *   - `apps/mcp-server/__tests__/unit/tools/*.test.ts`
 *   - any future `@coodra/tools-*` package's manifest tests
 *
 * Kept in `@coodra/shared/test-utils` (subpath export) rather than
 * inlined in the mcp-server because:
 *   1. §24.3 is a protocol rule, not a server-implementation detail.
 *   2. Future tool packages shipped outside `apps/mcp-server/` need the
 *      same check without pulling the server package as a dev dep.
 *   3. One file, one contract, one failure message when §24.3 evolves.
 *
 * This module is test-utility code — it may use `assert`-style throws
 * because the only caller is a unit test that wants a readable diff
 * on failure.
 */

/** Lower bound on manifest description length — set by `tool-registry.ts`. */
export const MIN_DESCRIPTION_LENGTH = 200 as const;

/** Upper bound on manifest description length — keeps `tools/list` pages tight. */
export const MAX_DESCRIPTION_LENGTH = 800 as const;

/**
 * Soft-target word count floor from §24.3. Descriptions below this
 * tend to skip either the "when to call" or the "what it returns"
 * half of the contract.
 */
export const MIN_DESCRIPTION_WORD_COUNT = 40 as const;

/**
 * Hard-max word count from §24.3 (amended 2026-04-23 per Q-02-6 —
 * previously 80, now 120 to allow one extra sentence of shape
 * documentation for tools with structured outputs).
 */
export const MAX_DESCRIPTION_WORD_COUNT = 120 as const;

/** Pattern that MCP tool names must match; mirrors `tool-registry.ts`. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

export interface ManifestDescriptionValidationOptions {
  /**
   * Optional folder name the tool lives under (e.g. `ping` for
   * `apps/mcp-server/src/tools/ping/`). When supplied, the helper
   * asserts `manifest.name === folderName.replace(/-/g, '_')` — i.e.
   * the name on the wire matches the directory on disk. The hyphen
   * → underscore translation exists because MCP tool names may not
   * contain hyphens but filesystem conventions sometimes do.
   */
  folderName?: string;
}

/**
 * Asserts a tool manifest description satisfies every §24.3 rule.
 *
 * Rules enforced (failure message names the specific rule):
 *   - Name matches `TOOL_NAME_PATTERN`.
 *   - Name matches `folderName` (when supplied).
 *   - Description length in `[MIN_DESCRIPTION_LENGTH, MAX_DESCRIPTION_LENGTH)`.
 *   - Description starts with "Call this" (case-insensitive) — the
 *     §24.3 recipe's canonical agent-directed opening.
 *   - Description word count in
 *     `[MIN_DESCRIPTION_WORD_COUNT, MAX_DESCRIPTION_WORD_COUNT]`.
 *   - Description contains "Returns" — so the return shape is
 *     documented inside the description itself (tools/list consumers
 *     do not resolve `outputSchema` $refs).
 *
 * Throws a plain `Error` (not `AppError`) because test frameworks
 * (vitest, jest) format plain-error messages into the diff panel
 * directly.
 */
export function assertManifestDescriptionValid(
  manifest: { name: string; description: string },
  options: ManifestDescriptionValidationOptions = {},
): void {
  const { name, description } = manifest;

  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new Error(
      `manifest name '${name}' does not match ${TOOL_NAME_PATTERN} — MCP tool names must be lowercase alphanumerics + underscores, 3–64 chars, starting with a letter.`,
    );
  }

  if (options.folderName !== undefined) {
    const expected = options.folderName.replace(/-/g, '_');
    if (name !== expected) {
      throw new Error(
        `manifest name '${name}' does not match folder '${options.folderName}' (expected '${expected}').`,
      );
    }
  }

  if (description.length < MIN_DESCRIPTION_LENGTH) {
    throw new Error(
      `manifest '${name}' description is ${description.length} chars; §24.3 requires ≥ ${MIN_DESCRIPTION_LENGTH}.`,
    );
  }

  if (description.length >= MAX_DESCRIPTION_LENGTH) {
    throw new Error(
      `manifest '${name}' description is ${description.length} chars; §24.3 caps length at < ${MAX_DESCRIPTION_LENGTH}.`,
    );
  }

  if (!/^call this/i.test(description)) {
    throw new Error(
      `manifest '${name}' description does not start with "Call this" — §24.3 requires the canonical agent-directed opening.`,
    );
  }

  const wordCount = description.trim().split(/\s+/).length;
  if (wordCount < MIN_DESCRIPTION_WORD_COUNT) {
    throw new Error(
      `manifest '${name}' description has ${wordCount} words; §24.3 requires ≥ ${MIN_DESCRIPTION_WORD_COUNT}.`,
    );
  }
  if (wordCount > MAX_DESCRIPTION_WORD_COUNT) {
    throw new Error(
      `manifest '${name}' description has ${wordCount} words; §24.3 caps at ${MAX_DESCRIPTION_WORD_COUNT} (amended 2026-04-23 per Q-02-6).`,
    );
  }

  if (!/Returns/.test(description)) {
    throw new Error(
      `manifest '${name}' description does not contain "Returns" — §24.3 requires the return-shape to be documented inline (tools/list consumers do not resolve $refs).`,
    );
  }
}
