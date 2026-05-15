import { type BaseEnv, baseEnvSchema, parseEnv } from '@coodra/shared';
import { z } from 'zod';

/**
 * The one and only place in `@coodra/hooks-bridge` that reads
 * `process.env`. Same contract as `apps/mcp-server/src/config/env.ts`:
 * synchronous parse at module load, fail-fast on bad config, no
 * `string | undefined` leaks past this file.
 *
 * Module 03 S5 scope: HOOKS_BRIDGE_HOST + HOOKS_BRIDGE_PORT for the
 * Hono listener; COODRA_SQLITE_PATH for the local DB; the same
 * three-layer auth chain config that mcp-server's env carries
 * (LOCAL_HOOK_SECRET + Clerk keys). Mode-conditional Clerk strictness
 * mirrors the mcp-server contract.
 */

const SOLO_BYPASS_CLERK_SENTINEL = 'sk_test_replace_me' as const;

const hooksBridgeEnvSchema = baseEnvSchema
  .extend({
    /** Where pino writes log lines. Hooks Bridge accepts both. */
    COODRA_LOG_DESTINATION: z
      .enum(['stdout', 'stderr'])
      .default('stderr')
      .describe(
        "Where pino writes log lines. Defaults to 'stderr' to match mcp-server's convention; 'stdout' is allowed (no stdio frame to corrupt).",
      ),

    /**
     * TCP port for the Hono listener. Defaults to 3101 per
     * `system-architecture.md` §3.5. Use 0 for kernel-assigned port
     * in test harnesses.
     */
    HOOKS_BRIDGE_PORT: z.coerce
      .number()
      .int()
      .min(0)
      .max(65535)
      .default(3101)
      .describe(
        'TCP port for the Hooks Bridge HTTP listener (loopback in solo mode). Use 0 to ask the kernel for an ephemeral port (test harnesses).',
      ),

    /**
     * Bind address. Loopback by default — solo mode is single-developer
     * and exposing 3101 on a LAN interface would bypass auth without
     * operator intent. Team-mode operators set explicitly.
     */
    HOOKS_BRIDGE_HOST: z
      .string()
      .min(1)
      .default('127.0.0.1')
      .describe(
        'Bind host for the Hooks Bridge HTTP listener. Default 127.0.0.1 (solo / loopback). Team operators override.',
      ),

    /**
     * Shared secret for the X-Local-Hook-Secret header. The shell
     * adapters (S11) bake this into the curl invocation. Required in
     * team mode where the agent's POST may come from a separate
     * adapter process; optional in solo mode where the IDE-spawned
     * Claude Code session may use solo-bypass instead.
     */
    LOCAL_HOOK_SECRET: z
      .string()
      .min(16, 'LOCAL_HOOK_SECRET must be at least 16 characters if set')
      .optional()
      .describe('Shared secret for the X-Local-Hook-Secret header.'),

    /** Clerk publishable key. Mode-conditional required-ness below. */
    CLERK_PUBLISHABLE_KEY: z
      .string()
      .regex(/^pk_(test|live)_/, "CLERK_PUBLISHABLE_KEY must start with 'pk_test_' or 'pk_live_'")
      .optional()
      .describe('Clerk publishable (frontend) key. Required in team mode unless the solo-bypass sentinel is set.'),

    /** Clerk secret key. Mode-conditional required-ness below. */
    CLERK_SECRET_KEY: z
      .string()
      .refine(
        (v) => v === SOLO_BYPASS_CLERK_SENTINEL || /^sk_(test|live)_/.test(v),
        "CLERK_SECRET_KEY must start with 'sk_test_' or 'sk_live_' (or be the solo-bypass sentinel 'sk_test_replace_me')",
      )
      .optional()
      .describe('Clerk secret (backend) key. Required in team mode unless the solo-bypass sentinel is set.'),

    /** Clerk JWT issuer URL, used by `@coodra/shared/auth::verifyClerkJwt`. */
    CLERK_JWT_ISSUER: z
      .string()
      .url()
      .optional()
      .describe("Clerk tenant JWT issuer URL (e.g. 'https://clerk.<tenant>.dev')."),

    /**
     * Local SQLite path. Module 03 S4 makes this the only DB path —
     * Hooks Bridge always runs on local SQLite, in both solo and team
     * mode, per `system-architecture.md` §1.
     */
    COODRA_SQLITE_PATH: z
      .string()
      .min(1)
      .optional()
      .describe('Override path for the local SQLite database. Defaults to ~/.coodra/data.db.'),
  })
  .superRefine((env, ctx) => {
    // Same Clerk strictness as mcp-server (Module 02 addition C):
    // team mode with a non-sentinel secret requires BOTH Clerk keys.
    if (env.COODRA_MODE === 'team' && env.CLERK_SECRET_KEY !== SOLO_BYPASS_CLERK_SENTINEL) {
      if (!env.CLERK_SECRET_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CLERK_SECRET_KEY'],
          message:
            'team mode requires CLERK_SECRET_KEY (set it to a real sk_test_/sk_live_ key, or use the solo-bypass sentinel sk_test_replace_me for local dev only)',
        });
      }
      if (!env.CLERK_PUBLISHABLE_KEY) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CLERK_PUBLISHABLE_KEY'],
          message: 'team mode requires CLERK_PUBLISHABLE_KEY (pk_test_/pk_live_) when CLERK_SECRET_KEY is set',
        });
      }
    }
  });

export type HooksBridgeEnv = z.infer<typeof hooksBridgeEnvSchema> & BaseEnv;

/**
 * Typed env singleton. Parsed exactly once, at first import.
 */
export const env: HooksBridgeEnv = parseEnv(hooksBridgeEnvSchema) as HooksBridgeEnv;

/**
 * Exposed for unit tests only — they reload the module under different
 * fixtures and need access to the raw schema.
 */
export const __internal = {
  schema: hooksBridgeEnvSchema,
  SOLO_BYPASS_CLERK_SENTINEL,
};
