import { AppError, InternalError, isAppError } from '@coodra/shared';

/**
 * `apps/mcp-server/src/lib/errors.ts` — error-shape translation for
 * the lib layer.
 *
 * Two jobs:
 *   1. A dedicated `NotImplementedError` so S7a can land the lib
 *      factory shape without pretending to have the full
 *      implementation. S7b/c replace the `throw` statements with the
 *      real bodies; all call sites already catch `AppError` so the
 *      swap is invisible to handlers.
 *   2. `mcpErrorResult(err)` — adapter from any `AppError` subclass
 *      to the MCP `{ content, isError }` envelope. The registry and
 *      every tool handler use this instead of hand-rolling the shape,
 *      so CI can assert a single recognisable shape across all 8
 *      tools (see `system-architecture.md §24.9`).
 *
 * Why not just `InternalError`? A typed `NotImplementedError` keeps
 * unit tests grep-able (`toThrow(NotImplementedError)`) and lets us
 * statically rule out the "ran in production accidentally" case in
 * S7c's integration tests — a test runner can `expect().not.toThrow
 * (NotImplementedError)` after the real impl lands without touching
 * every test body.
 */

export interface McpToolErrorEnvelope {
  readonly content: ReadonlyArray<{ type: 'text'; text: string }>;
  readonly isError: true;
}

/**
 * `NotImplementedError` — thrown by lib-factory stubs that exist only
 * to lock the ToolContext shape in S7a. The actual implementation
 * lands in a later slice (S7b for auth/policy, S7c for the domain
 * stores). Extends `InternalError` so existing `isAppError` callers
 * already handle it; carries a `subsystem` hint so a stacktrace
 * alone names the missing module.
 */
export class NotImplementedError extends InternalError {
  public readonly subsystem: string;
  constructor(subsystem: string, cause?: unknown) {
    super(`${subsystem}: not implemented yet (S7b/S7c will land it)`, cause);
    this.name = 'NotImplementedError';
    this.subsystem = subsystem;
    // Preserve prototype chain after transpilation, matching AppError.
    Object.setPrototypeOf(this, NotImplementedError.prototype);
  }
}

/**
 * Translate any error into the MCP `{ content, isError }` envelope
 * every tool handler returns on failure. `AppError` subclasses are
 * serialised via their `toJSON`; unknown errors surface as
 * `{ ok: false, error: 'internal', message }` so we never leak a
 * stacktrace into agent-visible content.
 */
export function mcpErrorResult(err: unknown): McpToolErrorEnvelope {
  if (isAppError(err)) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: false, error: err.code.toLowerCase(), ...err.toJSON() }),
        },
      ],
      isError: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: false, error: 'internal', message }),
      },
    ],
    isError: true,
  };
}

/** Re-exported so lib modules can `throw new ValidationError(...)` from one import. */
export { AppError };
