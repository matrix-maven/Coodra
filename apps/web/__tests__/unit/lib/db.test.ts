import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _clearWebDbCache, createWebDb } from '@/lib/db';

describe('createWebDb', () => {
  const originalMode = process.env.CONTEXTOS_MODE;
  const originalUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    _clearWebDbCache();
  });

  afterEach(() => {
    if (originalMode !== undefined) process.env.CONTEXTOS_MODE = originalMode;
    else delete process.env.CONTEXTOS_MODE;
    if (originalUrl !== undefined) process.env.DATABASE_URL = originalUrl;
    else delete process.env.DATABASE_URL;
    _clearWebDbCache();
  });

  it('throws in team mode when DATABASE_URL is missing', () => {
    process.env.CONTEXTOS_MODE = 'team';
    delete process.env.DATABASE_URL;
    expect(() => createWebDb()).toThrow(/CONTEXTOS_MODE=team requires DATABASE_URL/);
  });

  it('caches handle across calls (returns same reference)', () => {
    process.env.CONTEXTOS_MODE = 'team';
    process.env.DATABASE_URL = 'postgres://invalid/will-not-connect-but-handle-creates-lazily';
    const a = createWebDb();
    const b = createWebDb();
    expect(a).toBe(b);
  });

  it('selects sqlite kind in solo mode', () => {
    process.env.CONTEXTOS_MODE = 'solo';
    process.env.CONTEXTOS_HOME = `/tmp/cxos-web-test-${Math.random().toString(36).slice(2)}`;
    const handle = createWebDb();
    expect(handle.kind).toBe('sqlite');
  });

  it('selects sqlite kind when CONTEXTOS_MODE is unset', () => {
    delete process.env.CONTEXTOS_MODE;
    process.env.CONTEXTOS_HOME = `/tmp/cxos-web-test-${Math.random().toString(36).slice(2)}`;
    const handle = createWebDb();
    expect(handle.kind).toBe('sqlite');
  });

  it('returns a postgres handle in team mode with valid URL', () => {
    process.env.CONTEXTOS_MODE = 'team';
    process.env.DATABASE_URL = 'postgres://localhost:5432/test';
    const handle = createWebDb();
    expect(handle.kind).toBe('postgres');
  });
});
