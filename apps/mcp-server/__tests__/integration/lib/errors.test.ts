import { ConflictError, InternalError, UnauthorizedError, ValidationError } from '@coodra/shared';
import { describe, expect, it } from 'vitest';

import { mcpErrorResult, NotImplementedError } from '../../../src/lib/errors.js';

/**
 * Integration test for `src/lib/errors.ts`.
 *
 * Two things to lock here:
 *   1. `NotImplementedError` extends `InternalError` (via `AppError`)
 *      and carries a `subsystem` tag. The name is specifically
 *      `'NotImplementedError'` so `toThrow(NotImplementedError)` in
 *      other integration tests works reliably.
 *   2. `mcpErrorResult(err)` produces a single-text-content MCP
 *      envelope with `isError: true`, and preserves the AppError
 *      `code` in lowercase on the payload.
 */

describe('lib/errors — NotImplementedError', () => {
  it('extends InternalError and exposes the subsystem tag', () => {
    const err = new NotImplementedError('feature-pack.get');
    expect(err).toBeInstanceOf(InternalError);
    expect(err.name).toBe('NotImplementedError');
    expect(err.subsystem).toBe('feature-pack.get');
    expect(err.code).toBe('INTERNAL');
    expect(err.statusCode).toBe(500);
  });

  it('preserves the cause chain when one is supplied', () => {
    const root = new Error('root cause');
    const err = new NotImplementedError('context-pack.write', root);
    expect((err as unknown as { cause?: Error }).cause).toBe(root);
  });
});

describe('lib/errors — mcpErrorResult', () => {
  it('translates a ValidationError into a lowercase-coded MCP envelope', () => {
    const env = mcpErrorResult(new ValidationError('bad input shape'));
    expect(env.isError).toBe(true);
    expect(env.content).toHaveLength(1);
    const payload = JSON.parse(env.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('validation_error');
    expect(payload.code).toBe('VALIDATION_ERROR');
    expect(payload.statusCode).toBe(400);
  });

  it('translates an UnauthorizedError into a 401-coded envelope', () => {
    const env = mcpErrorResult(new UnauthorizedError());
    const payload = JSON.parse(env.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(payload.error).toBe('unauthorized');
    expect(payload.statusCode).toBe(401);
  });

  it('translates a ConflictError into a 409-coded envelope', () => {
    const env = mcpErrorResult(new ConflictError('duplicate idempotency key'));
    const payload = JSON.parse(env.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(payload.error).toBe('conflict');
    expect(payload.statusCode).toBe(409);
  });

  it('translates an unknown (non-AppError) throwable into { error: "internal", message }', () => {
    const env = mcpErrorResult(new Error('mystery'));
    const payload = JSON.parse(env.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(payload.error).toBe('internal');
    expect(payload.message).toBe('mystery');
  });

  it('translates a NotImplementedError (subclass of AppError) with the INTERNAL code', () => {
    const env = mcpErrorResult(new NotImplementedError('feature-pack.get'));
    const payload = JSON.parse(env.content[0]?.text ?? '{}') as Record<string, unknown>;
    expect(payload.error).toBe('internal');
    expect(payload.message).toMatch(/not implemented yet/);
  });
});
