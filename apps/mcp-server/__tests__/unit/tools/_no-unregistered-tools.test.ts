import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DbHandle } from '@coodra/db';
import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../../src/framework/tool-registry.js';
import { registerAllTools } from '../../../src/tools/index.js';
import { makeFakeDeps } from '../../helpers/fake-deps.js';

/**
 * Guard test — every folder under `src/tools/<name>/` must have a
 * corresponding registration in `tools/index.ts::registerAllTools`.
 * The failure mode this guards against is documented in
 * `essentialsforclaude/10-troubleshooting.md`: `tools/list` returning
 * empty because a manifest was written but not wired into the
 * registration barrel.
 *
 * The test is a lexical directory walk — it does NOT import every
 * manifest (avoids double-construction of factories that close over
 * DB handles). It converts each folder name to its canonical tool
 * name via `folder.replace(/-/g, '_')` (e.g. `get-run-id` →
 * `get_run_id`), then asserts the registry's `list()` contains that
 * name after `registerAllTools` runs.
 *
 * Self-sanity: the folder-to-name translation is its own sample
 * fixture test so a future refactor that loosens the mapping fails
 * on that assertion before it silently skips real tools.
 */

const TOOLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src/tools');

function walkToolFolders(): ReadonlyArray<string> {
  return readdirSync(TOOLS_DIR)
    .filter((entry) => !entry.startsWith('.') && !entry.startsWith('_') && !entry.endsWith('.ts'))
    .filter((entry) => statSync(join(TOOLS_DIR, entry)).isDirectory());
}

function folderToToolName(folder: string): string {
  return folder.replace(/-/g, '_');
}

// A fake DbHandle is enough for registration — handler closures are
// never invoked in this guard test.
const fakeDb = { kind: 'sqlite', db: {}, raw: {}, close: () => {} } as unknown as DbHandle;

describe('_no-unregistered-tools — self-sanity of folder → tool-name translation', () => {
  it('converts hyphens to underscores and leaves alphanumerics intact', () => {
    expect(folderToToolName('get-run-id')).toBe('get_run_id');
    expect(folderToToolName('ping')).toBe('ping');
    expect(folderToToolName('save-context-pack')).toBe('save_context_pack');
  });

  it('does NOT drop or mangle other characters', () => {
    expect(folderToToolName('a-b-c-d')).toBe('a_b_c_d');
    expect(folderToToolName('tool_with_underscores')).toBe('tool_with_underscores');
  });
});

describe('_no-unregistered-tools — every src/tools folder is registered', () => {
  it('walkToolFolders returns a non-empty list that includes known tools', () => {
    const folders = walkToolFolders();
    expect(folders.length).toBeGreaterThan(0);
    expect(folders).toContain('ping');
    expect(folders).toContain('get-run-id');
  });

  it('every folder maps to a registered tool name', () => {
    const registry = new ToolRegistry({ deps: makeFakeDeps() });
    registerAllTools(registry, { db: fakeDb, mode: 'solo' });
    const registeredNames = new Set(registry.list().map((t) => t.name));

    const folders = walkToolFolders();
    for (const folder of folders) {
      const expectedName = folderToToolName(folder);
      expect(
        registeredNames.has(expectedName),
        `Folder src/tools/${folder}/ exists but '${expectedName}' is not in registerAllTools. Wire it into tools/index.ts.`,
      ).toBe(true);
    }
  });

  it('every registered tool has a matching folder (inverse: no dangling registrations)', () => {
    const registry = new ToolRegistry({ deps: makeFakeDeps() });
    registerAllTools(registry, { db: fakeDb, mode: 'solo' });
    const registeredNames = registry.list().map((t) => t.name);

    const folderNames = new Set(walkToolFolders().map(folderToToolName));
    for (const name of registeredNames) {
      expect(
        folderNames.has(name),
        `Tool '${name}' is registered but has no matching folder under src/tools/. Did you delete the folder without removing the registration?`,
      ).toBe(true);
    }
  });
});
