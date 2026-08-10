import { describe, expect, it } from 'vitest';

import { parseFeatureMd, renderFeatureMd } from '../../../src/features/parse.js';

/**
 * Phase A unit tests — feature.md parser.
 *
 * The parser is the load-bearing layer for every other feature surface
 * (CLI, bridge, MCP, web). If parsing is wrong here, every downstream
 * consumer is wrong. So this suite covers:
 *
 *   - happy path: well-formed frontmatter parses to a typed shape
 *   - shape variants: snake_case ↔ camelCase aliases, block scalars
 *   - structural failures: each one returns a distinct error code
 *   - quality warnings: short / non-imperative / abstract descriptions
 *     surface as warnings, not errors
 *   - render() is the inverse of parse(): round-trip is byte-stable
 */

describe('parseFeatureMd — happy paths', () => {
  it('parses a minimal valid frontmatter + body', () => {
    const raw = [
      '---',
      'name: payments-flow',
      'description: Use this when working on Stripe charges or refunds.',
      '---',
      '',
      '# Payments flow',
      '',
      'Body content goes here.',
      '',
    ].join('\n');
    const out = parseFeatureMd(raw);
    expect(out.errors).toEqual([]);
    expect(out.frontmatter).not.toBeNull();
    expect(out.frontmatter?.name).toBe('payments-flow');
    expect(out.frontmatter?.description).toBe('Use this when working on Stripe charges or refunds.');
    expect(out.body).toContain('# Payments flow');
    expect(out.body).toContain('Body content goes here.');
  });

  it('parses block-scalar (multi-line) descriptions', () => {
    const raw = [
      '---',
      'name: auth',
      'description: |',
      '  Use this when working on login,',
      '  JWT validation, or RBAC.',
      'when_not_to_use: |',
      '  Skip for OAuth setup — see `oauth-setup`.',
      'maturity: stable',
      'tags: [auth, security]',
      '---',
      '# Auth',
    ].join('\n');
    const out = parseFeatureMd(raw);
    expect(out.errors).toEqual([]);
    expect(out.frontmatter?.description).toContain('Use this when working on login,');
    expect(out.frontmatter?.description).toContain('JWT validation');
    expect(out.frontmatter?.whenNotToUse).toContain('OAuth setup');
    expect(out.frontmatter?.maturity).toBe('stable');
    expect(out.frontmatter?.tags).toEqual(['auth', 'security']);
  });

  it('accepts both snake_case and camelCase frontmatter keys', () => {
    const snake = parseFeatureMd(
      [
        '---',
        'name: foo',
        'description: Use this when working with foo.',
        'when_not_to_use: Use this when not to use foo.',
        '---',
        '',
      ].join('\n'),
    );
    const camel = parseFeatureMd(
      [
        '---',
        'name: foo',
        'description: Use this when working with foo.',
        'whenNotToUse: Use this when not to use foo.',
        '---',
        '',
      ].join('\n'),
    );
    expect(snake.frontmatter?.whenNotToUse).toBe('Use this when not to use foo.');
    expect(camel.frontmatter?.whenNotToUse).toBe('Use this when not to use foo.');
  });

  it('tolerates CRLF line endings (Windows / web-form pasted)', () => {
    const raw = '---\r\nname: foo\r\ndescription: Use this when working on foo.\r\n---\r\nbody\r\n';
    const out = parseFeatureMd(raw);
    expect(out.errors).toEqual([]);
    expect(out.frontmatter?.name).toBe('foo');
  });

  it('strips a leading UTF-8 BOM', () => {
    const raw = `﻿---\nname: foo\ndescription: Use this when working on foo.\n---\nbody\n`;
    const out = parseFeatureMd(raw);
    expect(out.errors).toEqual([]);
    expect(out.frontmatter?.name).toBe('foo');
  });
});

describe('parseFeatureMd — structural failures', () => {
  it('errors when there is no opening fence', () => {
    const out = parseFeatureMd('# just a markdown file\n\nbody\n');
    expect(out.frontmatter).toBeNull();
    expect(out.errors[0]).toMatch(/frontmatter_missing_open_fence/);
  });

  it('errors when the frontmatter block is never closed', () => {
    const out = parseFeatureMd('---\nname: foo\ndescription: short\nbody');
    expect(out.frontmatter).toBeNull();
    expect(out.errors[0]).toMatch(/frontmatter_missing_close_fence/);
  });

  it('errors when YAML is malformed', () => {
    const out = parseFeatureMd('---\n: missing key\n  bad: indent\n---\nbody\n');
    expect(out.frontmatter).toBeNull();
    expect(
      out.errors.some((e) => /frontmatter_yaml_parse_failed|frontmatter_yaml_not_object|frontmatter_invalid/.test(e)),
    ).toBe(true);
  });

  it('errors when frontmatter is an array instead of a mapping', () => {
    const out = parseFeatureMd('---\n- not\n- a\n- mapping\n---\nbody\n');
    expect(out.frontmatter).toBeNull();
    expect(out.errors[0]).toMatch(/frontmatter_yaml_not_object/);
  });

  it('errors when name violates the slug regex', () => {
    const out = parseFeatureMd(
      ['---', 'name: NOT-A-SLUG', 'description: Use this when working on something specific.', '---', ''].join('\n'),
    );
    expect(out.frontmatter).toBeNull();
    expect(out.errors.some((e) => /name.*lowercase letters/.test(e))).toBe(true);
  });

  it('errors when description is missing', () => {
    const out = parseFeatureMd(['---', 'name: foo', '---', ''].join('\n'));
    expect(out.frontmatter).toBeNull();
    // Zod v4 wording is "Invalid input: expected string, received undefined"
    // for a missing required string. Match either the v3 "Required" message
    // OR the v4 path-prefixed error so the assertion survives Zod upgrades.
    expect(out.errors.some((e) => /frontmatter_invalid: description/.test(e))).toBe(true);
  });
});

describe('parseFeatureMd — quality warnings (non-fatal)', () => {
  it('warns when description is short', () => {
    const out = parseFeatureMd(['---', 'name: foo', 'description: Too short.', '---', ''].join('\n'));
    expect(out.errors).toEqual([]);
    expect(out.warnings.some((w) => /short \(< 30 chars\)/.test(w))).toBe(true);
  });

  it('warns when description starts with the TODO placeholder', () => {
    const out = parseFeatureMd(
      ['---', 'name: foo', 'description: "TODO: describe when this feature applies."', '---', ''].join('\n'),
    );
    expect(out.errors).toEqual([]);
    expect(out.warnings.some((w) => /TODO placeholder/.test(w))).toBe(true);
  });

  it('warns when description does not start with an imperative verb', () => {
    const out = parseFeatureMd(
      [
        '---',
        'name: foo',
        'description: This module implements the foo subsystem with everything you need.',
        '---',
        '',
      ].join('\n'),
    );
    // Long enough; just lacks the imperative trigger.
    expect(out.errors).toEqual([]);
    expect(out.warnings.some((w) => /imperative trigger/.test(w))).toBe(true);
  });

  it('warns when description has no concrete signal', () => {
    const out = parseFeatureMd(
      [
        '---',
        'name: foo',
        'description: Use this when you need to work with various things and do them well.',
        '---',
        '',
      ].join('\n'),
    );
    expect(out.errors).toEqual([]);
    expect(out.warnings.some((w) => /concrete signal/.test(w))).toBe(true);
  });

  it('does not warn for a high-quality description', () => {
    const out = parseFeatureMd(
      [
        '---',
        'name: foo',
        'description: |',
        '  Use this when working on `src/payments.ts` — Stripe charges, refunds,',
        '  webhook signing, and the `webhook_replay_guard` flow.',
        '---',
        '',
      ].join('\n'),
    );
    expect(out.errors).toEqual([]);
    expect(out.warnings).toEqual([]);
  });
});

describe('renderFeatureMd — inverse of parseFeatureMd', () => {
  it('renders a minimal feature and parses back to the same structure', () => {
    const rendered = renderFeatureMd({
      frontmatter: {
        name: 'foo',
        description: 'Use this when working on foo and the foo handler.',
      },
      body: '# Foo\n\nbody body body\n',
    });
    const parsed = parseFeatureMd(rendered);
    expect(parsed.errors).toEqual([]);
    expect(parsed.frontmatter?.name).toBe('foo');
    expect(parsed.frontmatter?.description).toBe('Use this when working on foo and the foo handler.');
    expect(parsed.body.trim()).toBe('# Foo\n\nbody body body');
  });

  it('emits a block scalar for long / multi-line descriptions', () => {
    const rendered = renderFeatureMd({
      frontmatter: {
        name: 'foo',
        description: 'Use this when working on foo.\nIt covers two flows.',
      },
      body: 'body\n',
    });
    expect(rendered).toContain('description: |');
    const parsed = parseFeatureMd(rendered);
    expect(parsed.errors).toEqual([]);
    expect(parsed.frontmatter?.description).toContain('It covers two flows.');
  });

  it('renders deterministically — same input twice produces identical bytes', () => {
    const args = {
      frontmatter: {
        name: 'foo',
        description: 'Use this when working on foo.',
        maturity: 'stable' as const,
        tags: ['auth', 'security'] as const,
      },
      body: 'body\n',
    };
    const a = renderFeatureMd(args);
    const b = renderFeatureMd(args);
    expect(a).toBe(b);
  });

  it('round-trips a fully-populated frontmatter', () => {
    const rendered = renderFeatureMd({
      frontmatter: {
        name: 'payments-flow',
        description: 'Use this when working on Stripe `charge` / `refund` flows.',
        whenNotToUse: 'Skip for PayPal — see `paypal-flow`.',
        maturity: 'stable',
        owners: ['platform-team', 'team-payments'],
        tags: ['payments', 'stripe'],
      },
      body: '# Payments\n\nbody\n',
    });
    const parsed = parseFeatureMd(rendered);
    expect(parsed.errors).toEqual([]);
    expect(parsed.frontmatter?.maturity).toBe('stable');
    expect(parsed.frontmatter?.owners).toEqual(['platform-team', 'team-payments']);
    expect(parsed.frontmatter?.tags).toEqual(['payments', 'stripe']);
  });
});
