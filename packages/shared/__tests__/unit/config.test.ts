import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { baseEnvSchema, loadBaseEnv, parseEnv } from '../../src/config.js';
import { ValidationError } from '../../src/errors/index.js';

describe('baseEnvSchema', () => {
  it('defaults COODRA_MODE to solo', () => {
    const parsed = parseEnv(baseEnvSchema, {});
    expect(parsed.COODRA_MODE).toBe('solo');
  });

  it('defaults LOG_LEVEL to info', () => {
    const parsed = parseEnv(baseEnvSchema, {});
    expect(parsed.LOG_LEVEL).toBe('info');
  });

  it('defaults NODE_ENV to development', () => {
    const parsed = parseEnv(baseEnvSchema, {});
    expect(parsed.NODE_ENV).toBe('development');
  });

  it('accepts team mode', () => {
    const parsed = parseEnv(baseEnvSchema, { COODRA_MODE: 'team' });
    expect(parsed.COODRA_MODE).toBe('team');
  });

  it('rejects invalid COODRA_MODE', () => {
    expect(() => parseEnv(baseEnvSchema, { COODRA_MODE: 'cloud' })).toThrow(ValidationError);
  });

  it('rejects invalid LOG_LEVEL', () => {
    expect(() => parseEnv(baseEnvSchema, { LOG_LEVEL: 'silly' })).toThrow(ValidationError);
  });

  it('rejects invalid NODE_ENV', () => {
    expect(() => parseEnv(baseEnvSchema, { NODE_ENV: 'staging' })).toThrow(ValidationError);
  });
});

describe('parseEnv with extended schema', () => {
  const serviceSchema = baseEnvSchema.extend({
    MCP_SERVER_PORT: z.coerce.number().int().positive().default(3100),
    DATABASE_URL: z.string().url().optional(),
  });

  it('coerces numeric strings', () => {
    const parsed = parseEnv(serviceSchema, { MCP_SERVER_PORT: '3200' });
    expect(parsed.MCP_SERVER_PORT).toBe(3200);
  });

  it('applies port default when unset', () => {
    const parsed = parseEnv(serviceSchema, {});
    expect(parsed.MCP_SERVER_PORT).toBe(3100);
  });

  it('accepts valid DATABASE_URL', () => {
    const parsed = parseEnv(serviceSchema, { DATABASE_URL: 'postgres://u:p@h:5432/db' });
    expect(parsed.DATABASE_URL).toBe('postgres://u:p@h:5432/db');
  });

  it('rejects non-url DATABASE_URL', () => {
    expect(() => parseEnv(serviceSchema, { DATABASE_URL: 'not-a-url' })).toThrow(ValidationError);
  });

  it('rejects negative port', () => {
    expect(() => parseEnv(serviceSchema, { MCP_SERVER_PORT: '-1' })).toThrow(ValidationError);
  });
});

describe('parseEnv error message', () => {
  it('lists every invalid field in the ValidationError message', () => {
    const schema = z.object({
      A: z.string().url(),
      B: z.coerce.number().int().positive(),
    });
    try {
      parseEnv(schema, { A: 'not-url', B: '-5' });
      expect.fail('parseEnv should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const v = err as ValidationError;
      expect(v.message).toContain('A');
      expect(v.message).toContain('B');
      expect(v.details).toEqual({ issueCount: 2 });
    }
  });
});

describe('loadBaseEnv', () => {
  it('returns a typed base env with defaults for empty input', () => {
    const env = loadBaseEnv({});
    expect(env).toEqual({
      NODE_ENV: 'development',
      COODRA_MODE: 'solo',
      LOG_LEVEL: 'info',
    });
  });
});
