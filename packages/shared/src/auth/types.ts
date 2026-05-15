/**
 * `@coodra/shared/auth/types` — auth-abstraction primitives shared
 * across services.
 *
 * Module 03 S3 moved this from `apps/mcp-server/src/framework/tool-
 * context.ts` (where `Identity` and `AuthClient` were originally
 * declared) so both `apps/mcp-server` and `apps/hooks-bridge` can
 * import the same shape. The original mcp-server file re-exports
 * these from here.
 */

/** Caller identity. Returned by `AuthClient.getIdentity` / `requireIdentity`. */
export interface Identity {
  readonly userId: string;
  readonly orgId: string | null;
  /** How the identity was resolved — audit trail. */
  readonly source: 'solo-bypass' | 'clerk' | 'local-hook';
}

/**
 * Auth abstraction. The solo-bypass factory (`createSoloAuthClient`)
 * and the Clerk-backed factory (`createClerkAuthClient`) both satisfy
 * this interface. Service code never branches on mode — `index.ts`
 * picks the factory once and the call site uses whatever it gets.
 */
export interface AuthClient {
  /** Returns the current identity, or null if no caller is attached. */
  getIdentity(): Promise<Identity | null>;
  /**
   * Like `getIdentity` but throws `UnauthorizedError` when missing.
   * Callers that strictly require an identity call this; callers that
   * optionally customise behaviour (e.g. per-user context) call
   * `getIdentity` and branch on null.
   */
  requireIdentity(): Promise<Identity>;
}

/**
 * Structural env subset the auth helpers consume. `apps/mcp-server`'s
 * `McpServerEnv` and `apps/hooks-bridge`'s future `HooksBridgeEnv`
 * are both supersets and structurally assignable to this. Decoupling
 * the auth code from any one app's full env shape lets the same
 * helpers serve every consumer.
 */
export interface AuthEnv {
  readonly CLERK_SECRET_KEY?: string | undefined;
  readonly CLERK_PUBLISHABLE_KEY?: string | undefined;
  readonly CLERK_JWT_ISSUER?: string | null | undefined;
  readonly COODRA_MODE?: 'solo' | 'team' | undefined;
}
