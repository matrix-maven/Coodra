import { z } from 'zod';

/**
 * Input + output schemas for `coodra__get_feature_file`.
 *
 *   - `{ ok: true, path, bytes, mediaType, content }`
 *
 *   - `{ ok: false, error: 'project_not_found',     howToFix }`
 *   - `{ ok: false, error: 'project_cwd_unknown',   howToFix }`
 *   - `{ ok: false, error: 'feature_not_found',     howToFix }`
 *   - `{ ok: false, error: 'file_not_found',        howToFix }`
 *   - `{ ok: false, error: 'extension_blocked',     howToFix, extension, allowed }`
 *   - `{ ok: false, error: 'file_too_large',        howToFix, bytes, capBytes }`
 *   - `{ ok: false, error: 'path_escape',           howToFix }`
 *
 * The `path_escape` branch fires if the requested path tries to leave
 * the feature directory via `..` segments or absolute paths. This is a
 * defensive check on top of the input regex; the regex catches the
 * common case but a defence-in-depth realpath compare costs ~nothing.
 */

const RELATIVE_PATH_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_\-./]{0,255}$/;

export const getFeatureFileInputSchema = z
  .object({
    projectSlug: z
      .string()
      .min(1, 'projectSlug is required')
      .max(128, 'projectSlug must be ≤ 128 chars'),
    slug: z
      .string()
      .min(1, 'slug is required')
      .max(64, 'slug must be ≤ 64 chars')
      .regex(/^[a-z0-9_-]+$/, 'slug must be lowercase letters, digits, hyphens or underscores'),
    path: z
      .string()
      .min(1, 'path is required')
      .max(256, 'path must be ≤ 256 chars')
      .regex(RELATIVE_PATH_RE, 'path must be a POSIX-style relative path (no leading slash, no `..` segments)')
      .refine((p) => !p.split('/').includes('..'), {
        message: 'path must not contain `..` segments',
      }),
  })
  .strict()
  .describe('Input for coodra__get_feature_file.');

const successBranch = z
  .object({
    ok: z.literal(true),
    path: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    /**
     * Best-effort media-type guess based on the file extension. Used by
     * the agent to decide how to present the content (markdown vs code
     * snippet vs plain text). Never `application/octet-stream` — the
     * extension allowlist filters out binary types so this is always
     * one of a small known set.
     */
    mediaType: z.string().min(1),
    content: z.string().describe('UTF-8 file contents.'),
  })
  .strict();

const projectNotFoundBranch = z
  .object({ ok: z.literal(false), error: z.literal('project_not_found'), howToFix: z.string().min(1) })
  .strict();

const projectCwdUnknownBranch = z
  .object({ ok: z.literal(false), error: z.literal('project_cwd_unknown'), howToFix: z.string().min(1) })
  .strict();

const featureNotFoundBranch = z
  .object({ ok: z.literal(false), error: z.literal('feature_not_found'), howToFix: z.string().min(1) })
  .strict();

const fileNotFoundBranch = z
  .object({ ok: z.literal(false), error: z.literal('file_not_found'), howToFix: z.string().min(1) })
  .strict();

const extensionBlockedBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('extension_blocked'),
    howToFix: z.string().min(1),
    extension: z.string(),
    allowed: z.array(z.string()),
  })
  .strict();

const fileTooLargeBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('file_too_large'),
    howToFix: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    capBytes: z.number().int().nonnegative(),
  })
  .strict();

const pathEscapeBranch = z
  .object({ ok: z.literal(false), error: z.literal('path_escape'), howToFix: z.string().min(1) })
  .strict();

// `z.union` (not discriminatedUnion) — see list-features/schema.ts.
export const getFeatureFileOutputSchema = z.union([
  successBranch,
  projectNotFoundBranch,
  projectCwdUnknownBranch,
  featureNotFoundBranch,
  fileNotFoundBranch,
  extensionBlockedBranch,
  fileTooLargeBranch,
  pathEscapeBranch,
]);

export type GetFeatureFileInput = z.infer<typeof getFeatureFileInputSchema>;
export type GetFeatureFileOutput = z.infer<typeof getFeatureFileOutputSchema>;
