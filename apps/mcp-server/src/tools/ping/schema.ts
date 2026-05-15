import { z } from 'zod';

/**
 * Input schema for `coodra__ping`. Deliberately tiny — `ping` is
 * the walking-skeleton tool that proves the registration framework,
 * stdio transport, policy wrapper, and idempotency-key contract all
 * work end-to-end. It does nothing domain-specific.
 *
 * The single `echo` field is capped at 256 chars so malicious or
 * accidental giant strings don't fill logs; the handler echoes it
 * back in the response unmodified.
 */
export const pingInputSchema = z
  .object({
    echo: z
      .string()
      .max(256, 'echo must be at most 256 characters')
      .optional()
      .describe('Optional string the server will include verbatim in the response. Useful for roundtrip tests.'),
  })
  .strict()
  .describe('Input for coodra__ping.');

/**
 * Output schema. Locking it as a Zod type lets the registry validate
 * the handler's return value before it crosses the transport — a
 * handler that returns the wrong shape fails CI rather than silently
 * misleading the agent.
 */
export const pingOutputSchema = z
  .object({
    ok: z.literal(true),
    pong: z.literal(true),
    serverTime: z.string().datetime().describe('ISO 8601 timestamp, server-side clock.'),
    sessionId: z.string().min(1).describe('Echo of the session id the registry passed to the handler.'),
    idempotencyKey: z.string().min(1).max(200).describe('The idempotency key the framework computed for this call.'),
    echo: z.string().optional().describe('Echo of the input echo field, if provided.'),
  })
  .strict();

export type PingInput = z.infer<typeof pingInputSchema>;
export type PingOutput = z.infer<typeof pingOutputSchema>;
