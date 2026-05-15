# 09 — Common Code Patterns

> Every pattern below must be wired for real. If you cannot wire it end-to-end in this session (missing secret, missing infra), stop and ask per `02-agent-human-boundary.md` §2.3 — do not ship a proxy that hardcodes a success response.

## 9.1 Creating a new MCP Tool

Every MCP tool has three files colocated in `apps/mcp-server/src/tools/<tool-name>/`:

- `handler.ts` — the implementation
- `schema.ts` — Zod input/output schemas
- `manifest.ts` — exports `{ name, description, inputSchema }` (see `system-architecture.md` §24.7)

```typescript
// apps/mcp-server/src/tools/my-new-tool/handler.ts
import { z } from 'zod';
import { db } from '../../lib/db.js';
import { logger } from '../../lib/logger.js';
import { myNewToolSchema, type MyNewToolInput } from './schema.js';

export async function myNewTool(input: MyNewToolInput) {
  const log = logger.child({ tool: 'my_new_tool', projectId: input.projectId });
  log.info('Tool invoked');

  try {
    const result = await db.query.someTable.findMany({
      where: eq(someTable.projectId, input.projectId),
    });

    log.info({ resultCount: result.length }, 'Tool completed');
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  } catch (err) {
    log.error({ err }, 'Tool failed');
    return {
      content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
      isError: true,
    };
  }
}
```

```typescript
// apps/mcp-server/src/tools/my-new-tool/manifest.ts
export const manifest = {
  name: 'my_new_tool',
  description:
    "Call this when <trigger condition>. Returns <shape>. <Why the agent needs it>. <When NOT to call>.",
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string' },
      query: { type: 'string' },
    },
    required: ['projectId', 'query'],
  },
} as const;
```

The tool's `manifest.ts` description MUST follow the five-part recipe in `system-architecture.md` §24.3. A `manifest.test.ts` file asserts: starts with imperative trigger phrase, 40–80 words, mentions return shape. Use `assertManifestDescriptionValid` from `@coodra/shared/test-utils` — do NOT hand-roll per-tool description assertions.

### 9.1.1 Factory-pattern tools vs static-const tools (landed S8)

Pick the right shape when you write a new tool:

- **Static const** when the handler is pure (no process-level config). Example: `ping`. Export `export const xxxToolRegistration: ToolRegistration<...> = { ... }`. The barrel `apps/mcp-server/src/tools/index.ts` imports and registers it directly.

- **Factory `createXxxToolRegistration(deps)`** when the handler needs a `DbHandle`, `COODRA_MODE`, a clock override, or any other boot-time config. The factory closes over `deps` and returns a `ToolRegistration`. The barrel calls the factory in `registerAllTools(registry, { db, mode })`.

    ```typescript
    // manifest.ts
    export interface MyToolDeps {
      readonly db: DbHandle;
      readonly mode: 'solo' | 'team';
    }

    export function createMyToolRegistration(deps: MyToolDeps): ToolRegistration<...> {
      return {
        name: 'my_tool',
        ...,
        handler: createMyToolHandler(deps), // closure over deps
      };
    }
    ```

    ```typescript
    // handler.ts
    export function createMyToolHandler(deps: MyToolDeps) {
      return async function handler(input, ctx): Promise<...> {
        // deps.db, deps.mode in scope
      };
    }
    ```

**Why not import `env` directly in the handler?** Because `env` is parsed once at module load — `vi.stubEnv('COODRA_MODE', 'team')` in a test fires after the module already captured the value, so the stub has no effect. Factory injection makes `mode` a parameter tests set per-call.

**How the barrel handles the split** (`apps/mcp-server/src/tools/index.ts`):

```typescript
export function registerAllTools(registry: ToolRegistry, deps: RegisterAllToolsDeps): void {
  registry.register(pingToolRegistration);                           // static
  registry.register(createGetRunIdToolRegistration(deps));           // factory
}
```

Uniform call site. Future tools pick the shape that fits; the barrel doesn't care.

### 9.1.2 Discriminated-union output schemas for soft-failures (landed S8)

When a tool has a **user-recoverable failure mode** (project not registered, index missing, embeddings not yet populated), DO NOT throw — return a structured soft-failure via a discriminated-union output schema:

```typescript
const successBranch = z.object({
  ok: z.literal(true),
  /* success fields */
}).strict();

const softFailureBranch = z.object({
  ok: z.literal(false),
  error: z.literal('project_not_found'),  // stable string error code
  howToFix: z.string().min(1),            // agent-surfaceable guidance
}).strict();

export const myToolOutputSchema = z.discriminatedUnion('ok', [successBranch, softFailureBranch]);
```

**Throw vs soft-failure rule:**
- **Throw** when the state is a programming bug or system fault (DB unreachable, unexpected null, invariant violated). The registry's generic `handler_threw` envelope is the right shape.
- **Soft-failure** when the state is a user-recoverable misconfiguration (slug not registered, feature-pack parent missing from disk, OAuth token expired). The agent reads `howToFix` and surfaces it to the user.

**Canonical soft-failure shape — required fields (landed S9):**

Every soft-failure branch MUST include BOTH `error: z.literal('<stable-code>')` AND `howToFix: z.string().min(1)`. Tool-specific fields (e.g. `chain` for a cycle error, `notice` for a fallback) are additive on top, but the two-field floor is non-negotiable — agents must always have an error code they can branch on AND a user-surfaceable remediation string. This rule applies across every tool in the server; don't invent a soft-failure shape without `howToFix`.

**Agent-caller contract — BOTH `ok` fields must be checked:**

The registry wraps every handler result as `{ ok: true, data: <handler_output> }`. The outer `ok` is transport success. The inner `data.ok` (present because the handler's output schema uses the discriminated union) is the domain success signal. Missing the inner check silently treats a soft-failure as success.

```typescript
// Correct — both levels checked:
const response = await client.callTool('get_run_id', { projectSlug: 'my-project' });
if (!response.ok) {
  // Transport failed — tool_not_found, handler_threw, invalid_input, etc.
  throw new Error(`Tool call failed: ${response.error}`);
}
if (!response.data.ok) {
  // Domain failure — surface response.data.howToFix to the user.
  return displayHowToFix(response.data.error, response.data.howToFix);
}
// Only here is `response.data.runId` safe to read.
const runId = response.data.runId;
```

**Wrong** (silently misreads `project_not_found` as success):

```typescript
// BAD — only checks the outer ok:
const response = await client.callTool('get_run_id', { projectSlug: 'my-project' });
if (response.ok) {
  const runId = response.data.runId;  // undefined if the inner ok is false!
}
```

If you are writing an agent that consumes a tool with a discriminated-union output, your contract is `response.ok && response.data.ok`. Tools that use this pattern: `get_run_id` (S8). Future tools that will use it: `search_packs_nl` (S11, `no_embeddings_yet` fallback), `query_codebase_graph` (S15, `graphify_index_missing` fallback). Plan your caller code accordingly.

## 9.2 Creating a new Hook Handler

```typescript
// apps/hooks-bridge/src/handlers/my-hook.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { logger } from '../lib/logger.js';

const inputSchema = z.object({
  session_id: z.string(),
  hook_event_name: z.literal('MyEvent'),
  // ... fields
});

export const myHookRoute = new Hono().post(
  '/',
  zValidator('json', inputSchema),
  async (c) => {
    const input = c.req.valid('json');
    const log = logger.child({ hook: 'MyEvent', sessionId: input.session_id });
    log.info('Hook received');

    // ... handle

    return c.json({ status: 'ok' });
  },
);
```

## 9.3 Writing a Test

```typescript
// __tests__/unit/tools/my-new-tool.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { myNewTool } from '../../../src/tools/my-new-tool/handler.js';

vi.mock('../../../src/lib/db.js', () => ({
  db: {
    query: {
      someTable: {
        findMany: vi.fn(),
      },
    },
  },
}));

describe('myNewTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns results for valid project', async () => {
    const { db } = await import('../../../src/lib/db.js');
    vi.mocked(db.query.someTable.findMany).mockResolvedValue([
      { id: '1', name: 'test' },
    ]);

    const result = await myNewTool({ projectId: 'uuid-here', query: 'test' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('test');
  });

  it('returns error for database failure', async () => {
    const { db } = await import('../../../src/lib/db.js');
    vi.mocked(db.query.someTable.findMany).mockRejectedValue(
      new Error('Connection refused'),
    );

    const result = await myNewTool({ projectId: 'uuid-here', query: 'test' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Connection refused');
  });
});
```
