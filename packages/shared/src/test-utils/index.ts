/**
 * `@coodra/shared/test-utils` — assertion helpers + fixtures
 * shared across every Coodra test suite that needs them. Kept
 * under a dedicated subpath (not re-exported from the package root)
 * so production consumers of `@coodra/shared` do not transitively
 * pick up test-only code in their bundle graph.
 *
 * Subpath contract (see `packages/shared/package.json`):
 *   import { assertManifestDescriptionValid } from '@coodra/shared/test-utils';
 */

export {
  ALL_REAL_ENVELOPES,
  CWD,
  MODEL,
  REAL_ENVELOPE_POST_TOOL_USE,
  REAL_ENVELOPE_PRE_TOOL_USE,
  REAL_ENVELOPE_SESSION_END,
  REAL_ENVELOPE_SESSION_START,
  REAL_ENVELOPE_STOP,
  REAL_ENVELOPE_USER_PROMPT_SUBMIT,
  SESSION_ID,
  TRANSCRIPT_PATH,
} from './fixtures/claude-code-real-envelope.js';
export {
  assertManifestDescriptionValid,
  MAX_DESCRIPTION_LENGTH,
  MAX_DESCRIPTION_WORD_COUNT,
  type ManifestDescriptionValidationOptions,
  MIN_DESCRIPTION_LENGTH,
  MIN_DESCRIPTION_WORD_COUNT,
  TOOL_NAME_PATTERN,
} from './manifest-assertions.js';
