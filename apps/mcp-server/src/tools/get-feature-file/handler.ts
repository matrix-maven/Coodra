import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

import { lookupProjectBySlug, type DbHandle } from '@coodra/db';
import { featuresRoot } from '@coodra/shared/features';
import { createLogger } from '@coodra/shared';

import type { ToolContext } from '../../framework/tool-context.js';
import type { GetFeatureFileInput, GetFeatureFileOutput } from './schema.js';

/**
 * Handler for `coodra__get_feature_file`.
 *
 * Returns the raw text contents of a single supporting file inside a
 * feature directory. Three gates protect against abuse:
 *
 *   1. **Path traversal.** The schema regex rejects `..` and absolute
 *      paths; the handler additionally `resolve`s the requested path
 *      and asserts it stays inside the feature directory after symlink
 *      resolution. Defence in depth.
 *
 *   2. **Extension allowlist.** Only text-shaped extensions are
 *      allowed. PDFs / images / binaries return `extension_blocked`
 *      with a hint to use the appropriate skill (e.g. pdf-viewer).
 *
 *   3. **Size cap.** Files over `MAX_FILE_BYTES` (256 KB) return
 *      `file_too_large` with the actual size + cap. Prevents the agent
 *      from blowing its context budget on a stray giant CSV.
 */

export interface GetFeatureFileHandlerDeps {
  readonly db: DbHandle;
}

const handlerLogger = createLogger('mcp-server.tool.get_feature_file');

const MAX_FILE_BYTES = 256 * 1024;

/**
 * Map extension → media-type. The allowlist is exactly these entries;
 * anything not in this set returns `extension_blocked`.
 */
const ALLOWED_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.txt', 'text/plain'],
  ['.json', 'application/json'],
  ['.yaml', 'text/yaml'],
  ['.yml', 'text/yaml'],
  ['.toml', 'text/toml'],
  ['.csv', 'text/csv'],
  ['.tsv', 'text/tab-separated-values'],
  ['.sql', 'text/x-sql'],
  ['.ts', 'text/x-typescript'],
  ['.tsx', 'text/x-typescript'],
  ['.js', 'text/javascript'],
  ['.jsx', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.cjs', 'text/javascript'],
  ['.py', 'text/x-python'],
  ['.rs', 'text/x-rust'],
  ['.go', 'text/x-go'],
  ['.java', 'text/x-java'],
  ['.rb', 'text/x-ruby'],
  ['.sh', 'text/x-shellscript'],
  ['.bash', 'text/x-shellscript'],
  ['.zsh', 'text/x-shellscript'],
  ['.html', 'text/html'],
  ['.css', 'text/css'],
  ['.xml', 'text/xml'],
]);

export function createGetFeatureFileHandler(
  deps: GetFeatureFileHandlerDeps,
): (input: GetFeatureFileInput, ctx: ToolContext) => Promise<GetFeatureFileOutput> {
  return async function handle(input, _ctx) {
    const project = await lookupProjectBySlug(deps.db, input.projectSlug);
    if (project === null) {
      return {
        ok: false,
        error: 'project_not_found',
        howToFix: `No projects row for slug "${input.projectSlug}". Run \`coodra init\` from the project root.`,
      };
    }
    if (project.cwd === null) {
      return {
        ok: false,
        error: 'project_cwd_unknown',
        howToFix:
          'This project has no recorded cwd. Open Claude Code inside the project root once so the bridge can backfill `projects.cwd`.',
      };
    }
    const featureDir = join(featuresRoot(project.cwd), input.slug);
    if (!existsSync(featureDir) || !statSync(featureDir).isDirectory()) {
      return {
        ok: false,
        error: 'feature_not_found',
        howToFix:
          `No feature at \`${featureDir}\`. Call \`coodra__list_features\` to see what's available, or scaffold via \`coodra feature add ${input.slug}\`.`,
      };
    }

    // Path-traversal defence in depth. The schema rejects `..` segments
    // and absolute paths; here we additionally `resolve` and verify the
    // result stays inside `featureDir`.
    if (isAbsolute(input.path)) {
      return {
        ok: false,
        error: 'path_escape',
        howToFix: 'path must be relative to the feature directory (no leading `/`).',
      };
    }
    const candidate = resolve(featureDir, input.path);
    const featureDirResolved = resolve(featureDir);
    const relPath = relative(featureDirResolved, candidate);
    if (relPath.startsWith('..') || isAbsolute(relPath)) {
      handlerLogger.warn(
        {
          event: 'get_feature_file_path_escape',
          projectSlug: input.projectSlug,
          slug: input.slug,
          requested: input.path,
          resolved: candidate,
        },
        'get_feature_file: refused path traversal attempt',
      );
      return {
        ok: false,
        error: 'path_escape',
        howToFix: 'path must stay inside the feature directory; `..` segments and symlinks pointing outside are refused.',
      };
    }

    if (!existsSync(candidate)) {
      return {
        ok: false,
        error: 'file_not_found',
        howToFix:
          `No file at \`${candidate}\`. Call \`coodra__get_feature\` to list valid paths under this feature.`,
      };
    }
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(candidate);
    } catch (err) {
      handlerLogger.warn(
        { event: 'get_feature_file_stat_failed', err: err instanceof Error ? err.message : String(err) },
        'get_feature_file: stat threw',
      );
      return {
        ok: false,
        error: 'file_not_found',
        howToFix: `Could not stat \`${candidate}\` — check filesystem permissions.`,
      };
    }
    if (!stat.isFile()) {
      return {
        ok: false,
        error: 'file_not_found',
        howToFix: `\`${candidate}\` is not a regular file.`,
      };
    }

    // Extension gate. The allowlist is text-shaped only — PDFs /
    // images / binaries return `extension_blocked` with a hint.
    const ext = extname(candidate).toLowerCase();
    const mediaType = ALLOWED_EXTENSIONS.get(ext);
    if (mediaType === undefined) {
      return {
        ok: false,
        error: 'extension_blocked',
        howToFix:
          ext === '.pdf'
            ? 'PDFs are not loaded into agent context — use the `pdf-viewer` skill to read the document interactively.'
            : `Files with extension "${ext}" are not allowed via get_feature_file. Allowed extensions are listed in the response.`,
        extension: ext,
        allowed: Array.from(ALLOWED_EXTENSIONS.keys()).sort(),
      };
    }

    if (stat.size > MAX_FILE_BYTES) {
      return {
        ok: false,
        error: 'file_too_large',
        howToFix:
          `File is ${stat.size} bytes; cap is ${MAX_FILE_BYTES}. Split the file into smaller pieces under this feature, or trim it.`,
        bytes: stat.size,
        capBytes: MAX_FILE_BYTES,
      };
    }

    let content: string;
    try {
      content = readFileSync(candidate, 'utf8');
    } catch (err) {
      handlerLogger.warn(
        { event: 'get_feature_file_read_failed', err: err instanceof Error ? err.message : String(err) },
        'get_feature_file: read threw',
      );
      return {
        ok: false,
        error: 'file_not_found',
        howToFix: `Could not read \`${candidate}\` — check filesystem permissions.`,
      };
    }

    return {
      ok: true,
      path: input.path,
      bytes: stat.size,
      mediaType,
      content,
    };
  };
}
