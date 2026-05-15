import { describe, expect, it } from 'vitest';

import {
  assertManifestDescriptionValid,
  MAX_DESCRIPTION_LENGTH,
  MAX_DESCRIPTION_WORD_COUNT,
  MIN_DESCRIPTION_LENGTH,
  MIN_DESCRIPTION_WORD_COUNT,
} from '../../../src/test-utils/manifest-assertions.js';

/**
 * One test per §24.3 rule. Test names read as rule labels so a CI
 * failure points directly at the rule that broke.
 *
 * Strategy: start from a valid "golden" manifest and mutate one
 * field per test. This matches the tool-registry enforcement tests
 * and keeps the fixture maintenance cost low when §24.3 evolves.
 */

/** Forty-one-word, 'Call this' / 'Returns'-bearing golden description. */
const GOLDEN_DESCRIPTION =
  'Call this tool when you need a zero-cost health check of the Coodra server. ' +
  'It round-trips a server timestamp, the session id, and the idempotency key the ' +
  'registry computed for the input — no filesystem, database, or policy side effects. ' +
  'Returns { ok, pong, serverTime, sessionId, echo? } on success.';

const GOLDEN = { name: 'ping', description: GOLDEN_DESCRIPTION };

describe('assertManifestDescriptionValid — happy path', () => {
  it('accepts a golden manifest without throwing', () => {
    expect(() => assertManifestDescriptionValid(GOLDEN)).not.toThrow();
  });

  it('accepts a golden manifest when folderName matches', () => {
    expect(() => assertManifestDescriptionValid(GOLDEN, { folderName: 'ping' })).not.toThrow();
  });

  it('accepts a hyphenated folderName if the name is the underscore form', () => {
    const m = { ...GOLDEN, name: 'feature_pack_get' };
    expect(() => assertManifestDescriptionValid(m, { folderName: 'feature-pack-get' })).not.toThrow();
  });
});

describe('assertManifestDescriptionValid — negative (one per rule)', () => {
  it('rejects a name that does not match the MCP pattern', () => {
    expect(() => assertManifestDescriptionValid({ ...GOLDEN, name: 'Ping' })).toThrow(/does not match/);
    expect(() => assertManifestDescriptionValid({ ...GOLDEN, name: 'pi' })).toThrow(/does not match/);
    expect(() => assertManifestDescriptionValid({ ...GOLDEN, name: '9ping' })).toThrow(/does not match/);
    expect(() => assertManifestDescriptionValid({ ...GOLDEN, name: 'has-hyphen' })).toThrow(/does not match/);
  });

  it('rejects a name mismatched against folderName (hyphen translation applied)', () => {
    expect(() => assertManifestDescriptionValid({ ...GOLDEN, name: 'pong' }, { folderName: 'ping' })).toThrow(
      /does not match folder/,
    );
  });

  it(`rejects descriptions shorter than MIN_DESCRIPTION_LENGTH (${MIN_DESCRIPTION_LENGTH})`, () => {
    const m = { ...GOLDEN, description: 'Call this tool. Returns { ok }.' };
    expect(() => assertManifestDescriptionValid(m)).toThrow(new RegExp(`≥ ${MIN_DESCRIPTION_LENGTH}`));
  });

  it(`rejects descriptions at or above MAX_DESCRIPTION_LENGTH (${MAX_DESCRIPTION_LENGTH})`, () => {
    const filler = 'x '.repeat(MAX_DESCRIPTION_LENGTH);
    const m = { ...GOLDEN, description: `Call this tool ${filler} Returns { ok }.` };
    expect(() => assertManifestDescriptionValid(m)).toThrow(new RegExp(`< ${MAX_DESCRIPTION_LENGTH}`));
  });

  it('rejects descriptions that do not start with "Call this"', () => {
    const m = {
      ...GOLDEN,
      description: GOLDEN_DESCRIPTION.replace(/^Call this/, 'This tool'),
    };
    expect(() => assertManifestDescriptionValid(m)).toThrow(/"Call this"/);
  });

  it(`rejects descriptions with fewer than MIN_DESCRIPTION_WORD_COUNT (${MIN_DESCRIPTION_WORD_COUNT}) words`, () => {
    // We need char length >= MIN_DESCRIPTION_LENGTH (200) and word
    // count < MIN_DESCRIPTION_WORD_COUNT (40). Build exactly 35
    // long tokens so word count is 35 and char length is ~350.
    const longWords = Array.from({ length: MIN_DESCRIPTION_WORD_COUNT - 5 }, () => 'longfillerword').join(' ');
    const description = `Call this ${longWords} Returns`;
    const words = description.trim().split(/\s+/).length;
    // Sanity-check the fixture meets the 'only word-count violates' invariant.
    expect(words).toBeLessThan(MIN_DESCRIPTION_WORD_COUNT);
    expect(description.length).toBeGreaterThanOrEqual(MIN_DESCRIPTION_LENGTH);
    expect(() => assertManifestDescriptionValid({ ...GOLDEN, description })).toThrow(
      new RegExp(`≥ ${MIN_DESCRIPTION_WORD_COUNT}`),
    );
  });

  it(`rejects descriptions with more than MAX_DESCRIPTION_WORD_COUNT (${MAX_DESCRIPTION_WORD_COUNT}) words`, () => {
    const words = Array.from({ length: MAX_DESCRIPTION_WORD_COUNT + 10 }, (_, i) => `w${i}`).join(' ');
    // keep under the char cap; MAX_DESC_LEN is 800 and 130 short words is ~500 chars
    const m = { ...GOLDEN, description: `Call this tool when you ${words} Returns { ok }.` };
    expect(() => assertManifestDescriptionValid(m)).toThrow(new RegExp(`caps at ${MAX_DESCRIPTION_WORD_COUNT}`));
  });

  it('rejects descriptions missing "Returns"', () => {
    const m = {
      ...GOLDEN,
      description: GOLDEN_DESCRIPTION.replace('Returns', 'Emits'),
    };
    expect(() => assertManifestDescriptionValid(m)).toThrow(/"Returns"/);
  });
});
