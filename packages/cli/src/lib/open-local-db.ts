import { createDb, type SqliteHandle } from '@coodra/db';

export interface OpenLocalDbOptions {
  /**
   * Load the sqlite-vec extension. Required when the handle will be used to
   * run migrations (the schema includes vec0 virtual tables) or when
   * reading/writing to `context_packs_vec`. Doctor's read-only invariant
   * checks default to `false` because they only touch ordinary tables.
   */
  readonly loadVecExtension?: boolean;
}

/**
 * Open a local SQLite handle for doctor / status / init slices.
 * Throws if the resolved handle is not SQLite (which can't happen given
 * `kind: 'local'`, but TS needs the narrowing).
 */
export async function openLocalDb(path: string, options: OpenLocalDbOptions = {}): Promise<SqliteHandle> {
  const handle = await createDb({
    kind: 'local',
    sqlite: { path, loadVecExtension: options.loadVecExtension ?? false },
  });
  if (handle.kind !== 'sqlite') {
    handle.close();
    throw new Error(`expected sqlite handle, got ${handle.kind}`);
  }
  return handle;
}
