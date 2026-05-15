import { randomUUID } from 'node:crypto';

import { createLogger, runKeySegmentSchema } from '@coodra/shared';
import type { z } from 'zod';

import {
  assertIdempotencyKeyBuilder,
  type IdempotencyContext,
  type IdempotencyKey,
  type IdempotencyKeyBuilder,
} from './idempotency.js';
import { type JsonSchemaObject, manifestFromZod } from './manifest-from-zod.js';
import { PolicyDenyError, type PolicyResult } from './policy-wrapper.js';
import type { ContextDeps, PerCallContext, ToolContext } from './tool-context.js';

/**
 * Tool-registration framework. The single source of enforcement for
 * the following invariants, all checked **synchronously at registration
 * time** (never at call time):
 *
 *   1. `name` matches the MCP tool-name shape `[a-z][a-z0-9_]{2,63}`
 *      AND does not already exist in the registry.
 *   2. `description` is ≥ 200 characters. `system-architecture.md`
 *      §24.3 requires each description to be a mini-prompt teaching
 *      the agent when, why, and how to call the tool. 200 chars is
 *      the floor; the real target is 40–120 words.
 *   3. `inputSchema` is a Zod `z.object(...)`. We reject anything
 *      else at the type level (handler typing is derived from
 *      `z.infer<typeof schema>`) AND at runtime (the JSON Schema
 *      output must have `type: 'object'`).
 *   4. `outputSchema` is a Zod type. Used for run-time validation of
 *      the handler's return value before it crosses the transport
 *      boundary — we want to fail CI rather than send a malformed
 *      result to the agent.
 *   5. `handler` takes exactly two args: the validated typed input
 *      and the frozen `ToolContext` (see `tool-context.ts`).
 *   6. `idempotencyKey` is a builder matching
 *      `IdempotencyKeyBuilder<Input>` (see `idempotency.ts`).
 *      Required — there is no opt-out. Read-only tools return a key
 *      with `kind: 'readonly'`.
 *
 * Every call goes through `handleCall`, which:
 *   a. validates input against the Zod schema (ZodError → structured
 *      refusal MCP response, not a throw);
 *   b. computes the idempotency key;
 *   c. runs the injected `PolicyCheck` with `phase: 'pre'`;
 *   d. calls the handler;
 *   e. validates output against the output Zod schema;
 *   f. runs the policy check with `phase: 'post'` (for audit);
 *   g. wraps the result in the MCP `{ content: [...] }` envelope.
 *
 * Handlers have no way to short-circuit step c or step f. This is
 * the "handlers cannot opt out" contract from the S5 directive.
 */

const registryLogger = createLogger('mcp-server.tool-registry');

/** MCP tool names: `^[a-z][a-z0-9_]{2,63}$` per §24 contract. */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;

/** Minimum description length enforced by the registration framework. */
export const MIN_DESCRIPTION_LENGTH = 200 as const;

/**
 * What a tool author writes. Exported so `src/tools/<name>/manifest.ts`
 * files can `satisfies ToolRegistration<Input, Output>` for static
 * coverage of the contract even before `registerTool` is called.
 *
 * Handler receives the full frozen `ToolContext` (see `tool-context.ts`)
 * — not a narrow `ToolCallContext` — so tools can reach every lib
 * client (db, auth, policy, …) through `ctx` without hidden imports.
 */
export interface ToolRegistration<InputSchema extends z.ZodType, OutputSchema extends z.ZodType> {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
  readonly idempotencyKey: IdempotencyKeyBuilder<z.infer<InputSchema>>;
  readonly handler: (input: z.infer<InputSchema>, ctx: ToolContext) => Promise<z.infer<OutputSchema>>;
}

/**
 * Internal shape the registry stores after registration. Includes the
 * precomputed JSON Schema so `listTools` is a constant-time reducer
 * and does not recompute on every MCP `tools/list` request.
 */
export interface RegisteredTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly inputJsonSchema: JsonSchemaObject;
  readonly idempotencyKey: IdempotencyKeyBuilder<unknown>;
  readonly handler: (input: unknown, ctx: ToolContext) => Promise<unknown>;
}

/** MCP tool result envelope. Matches the SDK's `CallToolResult` shape. */
export interface ToolResult {
  readonly content: ReadonlyArray<{ type: 'text'; text: string }>;
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
}

export interface ToolListEntry {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
}

export interface ToolRegistryOptions {
  /**
   * The frozen ContextDeps bag — db, logger, auth, policy, and every
   * domain lib client. Built once at boot in `src/index.ts` by
   * calling the `createXxxClient` factories in `src/lib/*`. The
   * registry folds this bag into every per-call `ToolContext` so
   * handlers receive the exact same instance for the lifetime of
   * the process.
   */
  readonly deps: ContextDeps;
  /**
   * Injected clock. Every `ToolContext.now()` call that handlers
   * make ultimately delegates here. Tests pass a frozen clock to
   * assert deterministic output; production defaults to the global
   * `Date` constructor (the ONLY place in `src/**` that calls
   * `new Date()` for tool-facing time — see
   * `__tests__/unit/tools/_no-raw-date.test.ts`).
   */
  readonly clock?: () => Date;
  /**
   * Per-call request-id minter. Defaults to `crypto.randomUUID()`.
   * Exposed for tests that want predictable ids.
   */
  readonly mintRequestId?: () => string;
}

/**
 * The registry is a named class rather than a module-level Map so
 * tests can spin up isolated instances. Production wires exactly one
 * instance in `index.ts`.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly deps: ContextDeps;
  private readonly clock: () => Date;
  private readonly mintRequestId: () => string;

  constructor(options: ToolRegistryOptions) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('ToolRegistry requires an options object');
    }
    const { deps, clock, mintRequestId } = options;
    if (!deps || typeof deps !== 'object') {
      throw new TypeError('ToolRegistry options.deps (ContextDeps) is required');
    }
    if (!deps.policy || typeof deps.policy.evaluate !== 'function') {
      throw new TypeError('ToolRegistry options.deps.policy must satisfy PolicyClient');
    }
    this.deps = deps;
    this.clock = clock ?? (() => new Date());
    this.mintRequestId = mintRequestId ?? (() => randomUUID());
  }

  /**
   * Registers a tool. Throws synchronously on any contract violation —
   * the server is expected to fail at startup rather than to come up
   * with a half-wired tool surface.
   */
  public register<I extends z.ZodType, O extends z.ZodType>(reg: ToolRegistration<I, O>): void {
    this.assertValid(reg);
    const inputJsonSchema = manifestFromZod(reg.inputSchema);

    const handlerForUnknown = reg.handler as (input: unknown, ctx: ToolContext) => Promise<unknown>;
    const idempotencyForUnknown = reg.idempotencyKey as IdempotencyKeyBuilder<unknown>;

    this.tools.set(reg.name, {
      name: reg.name,
      ...(reg.title !== undefined ? { title: reg.title } : {}),
      description: reg.description,
      inputSchema: reg.inputSchema,
      outputSchema: reg.outputSchema,
      inputJsonSchema,
      idempotencyKey: idempotencyForUnknown,
      handler: handlerForUnknown,
    });
    registryLogger.info(
      { event: 'tool_registered', tool: reg.name, descriptionLength: reg.description.length },
      `registered tool '${reg.name}'`,
    );
  }

  /**
   * Returns the `tools/list` response, sorted alphabetically by name
   * for stable serialization. Does NOT include the output schema —
   * the MCP spec only exposes input shape to clients.
   */
  public list(): ReadonlyArray<ToolListEntry> {
    const entries: ToolListEntry[] = [];
    for (const t of this.tools.values()) {
      entries.push({
        name: t.name,
        ...(t.title !== undefined ? { title: t.title } : {}),
        description: t.description,
        inputSchema: t.inputJsonSchema,
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Count of registered tools. Useful for assertions in tests. */
  public size(): number {
    return this.tools.size;
  }

  /**
   * Executes a tool call end-to-end. The transport layer (stdio in
   * S5, HTTP in S16) calls this and passes the resulting
   * `ToolResult` straight to the MCP SDK.
   *
   * Returns a result even for failure modes — a rejected promise
   * would leave the SDK to synthesise a generic error. We build the
   * envelope ourselves so clients see precise, actionable messages.
   */
  public async handleCall(
    name: string,
    rawInput: unknown,
    sessionId: string,
    options: { readonly requestId?: string; readonly agentType?: string } = {},
  ): Promise<ToolResult> {
    const { requestId, agentType = 'unknown' } = options;
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'tool_not_found', name }) }],
        isError: true,
      };
    }

    // Boundary-level sessionId validation (verification finding §8.6).
    // The runId encoding `run:{projectId}:{sessionId}:{uuid}` requires
    // sessionId to contain no `:`. The runtime check used to live in
    // `assertRunKeySegment` inside `generateRunKey`, which throws after
    // the handler enters and produces an opaque `handler_threw`
    // envelope. Validating here returns a structured `invalid_input`
    // envelope before any handler runs.
    const sessionParse = runKeySegmentSchema.safeParse(sessionId);
    if (!sessionParse.success) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: 'invalid_input',
              tool: name,
              field: 'sessionId',
              issues: sessionParse.error.issues,
            }),
          },
        ],
        isError: true,
      };
    }

    // The registry is the ONE place in `src/**` that constructs a
    // `Date` for tool-facing time. Handlers receive `ctx.now()` and
    // `ctx.receivedAt`; both delegate to `this.clock`, never the
    // global `Date` constructor. See
    // `__tests__/unit/tools/_no-raw-date.test.ts` for enforcement.
    const receivedAt = this.clock();
    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: 'invalid_input',
              tool: name,
              issues: parsed.error.issues,
            }),
          },
        ],
        isError: true,
      };
    }
    const input = parsed.data as unknown;

    let idempotencyKey: IdempotencyKey;
    try {
      idempotencyKey = tool.idempotencyKey(input, { sessionId, receivedAt });
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: 'idempotency_key_build_failed',
              tool: name,
              message: err instanceof Error ? err.message : String(err),
            }),
          },
        ],
        isError: true,
      };
    }

    const policyInputPre = {
      toolName: name,
      sessionId,
      idempotencyKey,
      input,
      phase: 'pre' as const,
    };

    let pre: PolicyResult;
    try {
      pre = await this.deps.policy.evaluate(policyInputPre);
    } catch (err) {
      // Fail-open per §7: policy evaluator outage must not block
      // tool calls. Log, proceed as 'allow'. S7b's real evaluator
      // wraps this in a circuit breaker; the registry simply trusts
      // whatever it gets back and logs exceptions.
      registryLogger.warn(
        {
          event: 'policy_check_threw',
          phase: 'pre',
          tool: name,
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        },
        'policy check threw; failing open',
      );
      pre = { decision: 'allow', reason: 'policy_check_unavailable', matchedRuleId: null };
    }

    if (pre.decision === 'deny') {
      const deny = new PolicyDenyError(name, pre.reason, pre.matchedRuleId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: 'policy_denied',
              tool: name,
              reason: deny.reason,
              matchedRuleId: deny.matchedRuleId,
            }),
          },
        ],
        isError: true,
      };
    }

    const perCall: PerCallContext = {
      toolName: name,
      sessionId,
      requestId: requestId ?? this.mintRequestId(),
      receivedAt,
      idempotencyKey,
      agentType,
      // Freeze the `now()` closure over `this.clock` so a handler
      // substituting its own clock at runtime has no effect — the
      // injection point is the registry constructor, full stop.
      now: () => this.clock(),
    };
    const ctx: ToolContext = Object.freeze({
      ...this.deps,
      ...perCall,
    });

    let handlerOutput: unknown;
    try {
      handlerOutput = await tool.handler(input, ctx);
    } catch (err) {
      registryLogger.error(
        {
          event: 'tool_handler_threw',
          tool: name,
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        },
        'tool handler threw',
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: 'handler_threw',
              tool: name,
              message: err instanceof Error ? err.message : String(err),
            }),
          },
        ],
        isError: true,
      };
    }

    const outValidated = tool.outputSchema.safeParse(handlerOutput);
    if (!outValidated.success) {
      registryLogger.error(
        {
          event: 'tool_output_invalid',
          tool: name,
          sessionId,
          issues: outValidated.error.issues,
        },
        'handler produced an output that failed its own outputSchema',
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: 'handler_output_invalid',
              tool: name,
              issues: outValidated.error.issues,
            }),
          },
        ],
        isError: true,
      };
    }

    // Post-phase policy check — for audit, not gating. The result is
    // logged but cannot override a successful handler. This matches
    // the Claude Code hook model where PostToolUse is observational.
    this.deps.policy.evaluate({ ...policyInputPre, phase: 'post' }).catch((err: unknown) => {
      registryLogger.warn(
        {
          event: 'policy_check_threw',
          phase: 'post',
          tool: name,
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        },
        'post-phase policy check threw; ignored',
      );
    });

    // 2026-05-08: write a `run_events` row for every successful MCP tool
    // call. Closes the visibility gap where the agent's
    // `coodra__record_decision` / `save_context_pack` / etc. were
    // invisible in the run timeline (only Bash/Edit/Write showed up via
    // the bridge's PostToolUse hook).
    //
    // Strategy:
    //   - If the tool's input has a non-empty `runId` field, record with
    //     that runId and `phase: 'mcp_call'`. This catches the high-value
    //     cases (record_decision, save_context_pack, etc.).
    //   - If no runId is available (ping, get_run_id itself, get_feature_pack
    //     called pre-runId), skip — the row would have null run_id and
    //     end up in the orphan-events bucket.
    //   - Fire-and-forget; failure is logged but never blocks the
    //     response.
    const inputRunId =
      typeof input === 'object' && input !== null && 'runId' in input
        ? (input as { runId?: unknown }).runId
        : undefined;
    if (typeof inputRunId === 'string' && inputRunId.length > 0) {
      void this.deps.runRecorder
        .record({
          runId: inputRunId,
          toolName: `coodra__${name}`,
          phase: 'mcp_call',
          sessionId,
          idempotencyKey,
          input,
          output: outValidated.data,
          decision: 'allow',
          reason: null,
        })
        .catch((err: unknown) => {
          registryLogger.warn(
            {
              event: 'mcp_call_event_record_failed',
              tool: name,
              sessionId,
              runId: inputRunId,
              err: err instanceof Error ? err.message : String(err),
            },
            'mcp_call run_event record threw; swallowing (audit-only path)',
          );
        });
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, data: outValidated.data }),
        },
      ],
      structuredContent: outValidated.data,
    };
  }

  /**
   * Synchronous registration-time guard. Called by `register`.
   * Visible for unit tests — they construct a fresh registry, call
   * this directly, and lock every failure mode individually.
   */
  public assertValid<I extends z.ZodType, O extends z.ZodType>(reg: ToolRegistration<I, O>): void {
    if (typeof reg.name !== 'string' || !TOOL_NAME_RE.test(reg.name)) {
      throw new TypeError(`invalid tool name '${reg.name}': must match ${TOOL_NAME_RE}`);
    }
    if (this.tools.has(reg.name)) {
      throw new TypeError(`tool '${reg.name}' is already registered`);
    }
    if (typeof reg.description !== 'string' || reg.description.length < MIN_DESCRIPTION_LENGTH) {
      throw new TypeError(
        `tool '${reg.name}' description must be at least ${MIN_DESCRIPTION_LENGTH} characters, got ${
          typeof reg.description === 'string' ? reg.description.length : '(not a string)'
        }. Tool descriptions are agent prompts; see system-architecture.md §24.3.`,
      );
    }
    if (!isZodObject(reg.inputSchema)) {
      throw new TypeError(
        `tool '${reg.name}' inputSchema must be a z.object(...). MCP tool inputs are always JSON objects.`,
      );
    }
    if (reg.outputSchema === undefined || reg.outputSchema === null) {
      throw new TypeError(`tool '${reg.name}' outputSchema is required`);
    }
    if (typeof reg.handler !== 'function') {
      throw new TypeError(`tool '${reg.name}' handler must be a function`);
    }
    if (reg.handler.length !== 2) {
      throw new TypeError(
        `tool '${reg.name}' handler must take exactly 2 args (input, ctx); got ${reg.handler.length}`,
      );
    }
    assertIdempotencyKeyBuilder(reg.idempotencyKey as IdempotencyKeyBuilder<unknown>, probeFor(reg.inputSchema));
  }
}

/**
 * Shallow-checks whether a Zod schema is an object at the top level.
 * Works across Zod v4's various object subclasses (strict/strip/passthrough)
 * by looking at the public `_def.type` discriminator.
 */
function isZodObject(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const def = (schema as { readonly _def?: { readonly type?: string } })._def;
  return def?.type === 'object';
}

/**
 * Produces a safe probe input for an idempotency-key builder. For
 * object schemas we pass the parsed "empty-defaults" object if the
 * schema accepts it, otherwise the raw `{}` (the builder is expected
 * to be robust to partially-populated inputs since it runs on
 * validated data in production).
 */
function probeFor(schema: z.ZodType): {
  input: unknown;
  ctx: IdempotencyContext;
} {
  const parsed = schema.safeParse({});
  const input = parsed.success ? parsed.data : {};
  return {
    input,
    ctx: {
      sessionId: 'probe_session',
      receivedAt: new Date(0),
    },
  };
}
