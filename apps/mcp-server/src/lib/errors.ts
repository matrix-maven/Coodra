import { AppError, isAppError } from '@coodra/shared';

/**
 * `apps/mcp-server/src/lib/errors.ts` — error-shape translation for
 * the lib layer.
 *
 * One job: `mcpErrorResult(err)` — adapter from any `AppError`
 * subclass to the MCP `{ content, isError }` envelope. The registry
 * and every tool handler use this instead of hand-rolling the shape,
 * so CI can assert a single recognisable shape across all tools
 * (see `system-architecture.md §24.9`).
 */

export interface McpToolErrorEnvelope {
  readonly content: ReadonlyArray<{ type: 'text'; text: string }>;
  readonly isError: true;
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
