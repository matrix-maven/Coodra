import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _clearWebDbCache, createWebDb } from '@/lib/db';

describe('createWebDb', () => {
  const originalMode = process.env.COODRA_MODE;
  const originalUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    _clearWebDbCache();
  });

  afterEach(() => {
    if (originalMode !== undefined) process.env.COODRA_MODE = originalMode;
    else delete process.env.COODRA_MODE;
    if (originalUrl !== undefined) process.env.DATABASE_URL = originalUrl;
    else delete process.env.DATABASE_URL;
    _clearWebDbCache();
  });

  it('throws in team mode when DATABASE_URL is missing', () => {
    process.env.COODRA_MODE = 'team';
    delete process.env.DATABASE_URL;
    expect(() => createWebDb()).toThrow(/COODRA_MODE=team requires DATABASE_URL/);
  });

  it('caches handle across calls (returns same reference)', () => {
    process.env.COODRA_MODE = 'team';
    process.env.DATABASE_URL = 'postgres://invalid/will-not-connect-but-handle-creates-lazily';
    const a = createWebDb();
    const b = createWebDb();
    expect(a).toBe(b);
  });

  it('selects sqlite kind in solo mode', () => {
    process.env.COODRA_MODE = 'solo';
    process.env.COODRA_HOME = `/tmp/cxos-web-test-${Math.random().toString(36).slice(2)}`;
    const handle = createWebDb();
    expect(handle.kind).toBe('sqlite');
  });

  it('selects sqlite kind when COODRA_MODE is unset', () => {
    delete process.env.COODRA_MODE;
    process.env.COODRA_HOME = `/tmp/cxos-web-test-${Math.random().toString(36).slice(2)}`;
    const handle = createWebDb();
    expect(handle.kind).toBe('sqlite');
  });

  it('returns a postgres handle in team mode with valid URL', () => {
    process.env.COODRA_MODE = 'team';
    process.env.DATABASE_URL = 'postgres://localhost:5432/test';
    const handle = createWebDb();
    expect(handle.kind).toBe('postgres');
  });
});
