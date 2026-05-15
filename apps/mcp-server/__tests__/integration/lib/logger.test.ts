import { describe, expect, it } from 'vitest';

import { createMcpLogger } from '../../../src/lib/logger.js';

/**
 * Integration test for `src/lib/logger.ts`.
 *
 * The factory wraps `@coodra/shared::createLogger` with an
 * `mcp-server.<moduleName>` namespace. This test locks:
 *   - non-empty moduleName is required;
 *   - returned logger has the pino-shaped methods tool code expects
 *     (info / warn / error / debug / trace), inherited from shared.
 *
 * Destination routing (stdout vs stderr) is already locked by
 * `packages/shared/__tests__/unit/logger.test.ts` and by the stdio
 * purity test; we do not re-test it here.
 */

describe('lib/logger — createMcpLogger', () => {
  it('rejects an empty moduleName', () => {
    expect(() => createMcpLogger('')).toThrow(/non-empty string/);
  });

  it('rejects a non-string moduleName', () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentional negative test
    expect(() => createMcpLogger(42 as unknown as any)).toThrow(/non-empty string/);
  });

  it('returns a pino-shaped logger', () => {
    const log = createMcpLogger('test-mod');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.debug).toBe('function');
  });

  it('two callers with different moduleNames get distinct loggers', () => {
    const a = createMcpLogger('a');
    const b = createMcpLogger('b');
    expect(a).not.toBe(b);
  });
});
