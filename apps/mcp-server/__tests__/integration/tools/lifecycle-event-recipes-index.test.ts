import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSqlite, type SqliteHandle } from '@coodra/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ContextDeps } from '../../../src/framework/tool-context.js';
import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { createContextPackStore } from '../../../src/lib/context-pack.js';
import { createDbClient } from '../../../src/lib/db.js';
import { createLifecycleEventToolRegistration } from '../../../src/tools/lifecycle-event/manifest.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * COOD-63 regression coverage: the Agent Recipes index was injected at
 * SessionStart only by `apps/hooks-bridge`. COOD-53 routed every native
 * plugin through `lifecycle_event`, which had no equivalent — so agents
 * had no way to discover which recipes exist unless they happened to
 * call `list_recipes` unprompted. (`coodra-recipe` and the
 * `get_recipe`/`list_recipes` tools were live the whole time; only the
 * discovery hint was missing.)
 */

interface Harness {
  readonly close: () => Promise<void>;
  readonly handle: SqliteHandle;
  readonly cwd: string;
  readonly deps: ContextDeps;
}

async function openHarness(projectSlug: string): Promise<Harness> {
  const { client, asInternalHandle } = createDbClient({
    mode: 'solo',
    sqlite: { path: ':memory:', skipPragmas: true },
  });
  const handle = asInternalHandle();
  if (handle.kind !== 'sqlite') throw new Error('expected sqlite handle');
  migrateSqlite(handle.db);

  const cwd = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-recipes-'));
  await mkdir(join(cwd, '.coodra'), { recursive: true });
  await writeFile(join(cwd, '.coodra', 'config.json'), JSON.stringify({ projectSlug }), 'utf8');

  const contextPacksRoot = await mkdtemp(join(tmpdir(), 'coodra-lifecycle-recipes-packs-'));
  const store = createContextPackStore({ db: handle, contextPacksRoot });
  const deps: ContextDeps = Object.freeze({ ...makeFakeDeps(), contextPack: store });

  return {
    close: async () => {
      await client.close();
    },
    handle,
    cwd,
    deps,
  };
}

async function seedRecipe(cwd: string, slug: string, description: string): Promise<void> {
  const dir = join(cwd, '.coodra', 'recipes', slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'recipe.md'),
    ['---', `name: ${slug}`, `description: ${description}`, 'maturity: stable', '---', '', `# ${slug}`, '', 'Body.'].join(
      '\n',
    ),
    'utf8',
  );
}

function buildRegistry(h: Harness): ToolRegistry {
  const registry = new ToolRegistry({ deps: h.deps });
  registry.register(createLifecycleEventToolRegistration({ db: h.handle, mode: 'solo' }));
  return registry;
}

async function sessionStartContext(registry: ToolRegistry, h: Harness, sessionId: string): Promise<string> {
  const result = await registry.handleCall(
    'lifecycle_event',
    { agentType: 'claude_code', rawPayload: { hook_event_name: 'SessionStart', session_id: sessionId, cwd: h.cwd } },
    'mcp-session',
    { agentType: 'claude_code' },
  );
  const structured = result.structuredContent as
    | { hookOutput?: { hookSpecificOutput?: { additionalContext?: string } } }
    | undefined;
  return structured?.hookOutput?.hookSpecificOutput?.additionalContext ?? '';
}

describe('lifecycle_event — Agent Recipes index injected at SessionStart (COOD-63)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await openHarness('proj-recipes');
  });
  afterEach(async () => {
    await h.close();
  });

  it('injects the recipes index into SessionStart additionalContext', async () => {
    await seedRecipe(h.cwd, 'ship-cleanly', 'Use this when preparing a release.');
    const registry = buildRegistry(h);

    const context = await sessionStartContext(registry, h, 'sess_recipes');

    expect(context).toContain('ship-cleanly');
    expect(context).toContain('Use this when preparing a release.');
    // The session contract must still be present — the recipes block is
    // additive, not a replacement.
    expect(context).toContain('Coodra session contract');
  });

  it('omits the block entirely for a project with no .coodra/recipes directory', async () => {
    const registry = buildRegistry(h);

    const context = await sessionStartContext(registry, h, 'sess_no_recipes');

    // Soft-fail by contract: no recipes dir → no block, but the rest of
    // SessionStart is unaffected.
    expect(context).toContain('Coodra session contract');
    expect(context).not.toContain('Agent Recipes');
  });

  it('surfaces multiple recipes so the agent can pick', async () => {
    await seedRecipe(h.cwd, 'alpha-recipe', 'First recipe description.');
    await seedRecipe(h.cwd, 'beta-recipe', 'Second recipe description.');
    const registry = buildRegistry(h);

    const context = await sessionStartContext(registry, h, 'sess_multi');

    expect(context).toContain('alpha-recipe');
    expect(context).toContain('beta-recipe');
  });
});
