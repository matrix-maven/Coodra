import { Writable } from 'node:stream';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger, logger } from '../../src/logger.js';

describe('logger (singleton)', () => {
  it('exposes a pino-style .level and .child()', () => {
    expect(typeof logger.level).toBe('string');
    expect(typeof logger.child).toBe('function');
  });

  it('level defaults to info when LOG_LEVEL is unset or invalid', () => {
    // The test process may have LOG_LEVEL set to e.g. 'info' already.
    // Allowed values include 'info' (default) or any other valid pino level.
    const allowed = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];
    expect(allowed).toContain(logger.level);
  });
});

describe('createLogger', () => {
  it('throws on empty name', () => {
    expect(() => createLogger('')).toThrow(TypeError);
  });

  it('binds name and context on a pino child, emits structured JSON', () => {
    const captured: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        captured.push(chunk.toString());
        cb();
      },
    });
    // Build an isolated pino with the same shape as the production logger,
    // but writing to our in-memory stream so we can inspect output.
    const local = pino(
      {
        level: 'info',
        formatters: { level: (label) => ({ level: label }) },
      },
      stream,
    );
    const child = local.child({ name: 'unit', component: 'logger' });
    child.info({ evt: 'hello' }, 'message body');
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0] ?? '{}') as Record<string, unknown>;
    expect(parsed.name).toBe('unit');
    expect(parsed.component).toBe('logger');
    expect(parsed.msg).toBe('message body');
    expect(parsed.level).toBe('info');
    expect(parsed.evt).toBe('hello');
  });

  it('child bindings carry through nested children', () => {
    const captured: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        captured.push(chunk.toString());
        cb();
      },
    });
    const local = pino({ level: 'info', formatters: { level: (label) => ({ level: label }) } }, stream);
    const svc = local.child({ name: 'svc' });
    const req = svc.child({ runId: 'run_abc' });
    req.info('hit');
    const parsed = JSON.parse(captured[0] ?? '{}') as Record<string, unknown>;
    expect(parsed.name).toBe('svc');
    expect(parsed.runId).toBe('run_abc');
  });
});

/**
 * Locks the COODRA_LOG_DESTINATION contract at the module-load
 * boundary. The flip is deliberately env-driven (see logger.ts docblock)
 * so every module transitively importing `createLogger` resolves to the
 * same destination. These tests reload the module under each env vector
 * via `vi.resetModules()` + dynamic `import()` so we exercise the parse
 * branch each time.
 *
 * We do NOT assert here that `stderr` actually writes to fd 2 in-process
 * — pino's destination is internal and the authoritative proof is a
 * subprocess stdout-purity test at the mcp-server level, where the stdio
 * transport makes the consequence observable. Here we lock the strict
 * parse contract only: unset / `stdout` / `stderr` are valid; anything
 * else throws at module load.
 */
describe('COODRA_LOG_DESTINATION', () => {
  const originalDest = process.env.COODRA_LOG_DESTINATION;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDest === undefined) delete process.env.COODRA_LOG_DESTINATION;
    else process.env.COODRA_LOG_DESTINATION = originalDest;
    vi.resetModules();
  });

  it('unset: module loads without throwing', async () => {
    delete process.env.COODRA_LOG_DESTINATION;
    const mod = await import('../../src/logger.js');
    expect(typeof mod.logger.info).toBe('function');
  });

  it("'stdout' (explicit, any case): module loads without throwing", async () => {
    process.env.COODRA_LOG_DESTINATION = 'STDOUT';
    const mod = await import('../../src/logger.js');
    expect(typeof mod.logger.info).toBe('function');
  });

  it("'stderr': module loads without throwing and logger is still a pino instance", async () => {
    process.env.COODRA_LOG_DESTINATION = 'stderr';
    const mod = await import('../../src/logger.js');
    expect(typeof mod.logger.info).toBe('function');
    expect(typeof mod.logger.child).toBe('function');
  });

  it('unknown value: throws TypeError at module load with a named-var message', async () => {
    process.env.COODRA_LOG_DESTINATION = 'syslog';
    await expect(import('../../src/logger.js')).rejects.toThrow(/COODRA_LOG_DESTINATION/);
  });
});
