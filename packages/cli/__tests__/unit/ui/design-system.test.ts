import { describe, expect, it } from 'vitest';
import { axisDivider, axisNode, axisParts } from '../../../src/ui/brand.js';
import {
  banner,
  checkGlyph,
  commandTitle,
  errorLine,
  footerHints,
  indentLines,
  kvBlock,
  kvRow,
  okLine,
  promptLine,
  sectionHead,
  summaryBar,
  timelineRow,
  warnLine,
} from '../../../src/ui/format.js';
import {
  LOGO_BLOCK,
  LOGO_HERO,
  LOGO_INLINE_PLAIN,
  renderLogoBlock,
  renderLogoHero,
  renderLogoInline,
} from '../../../src/ui/logo.js';
import { glyph, paint, TONE_GLYPH, VERDICT_GLYPH } from '../../../src/ui/theme.js';

/**
 * The design system is the visual contract for every terminal surface.
 * These assertions strip ANSI so they hold whether or not the runner's
 * stdout is a colour TTY — what matters is the *visible* layout: glyphs
 * in the right place, columns aligned, widths respected.
 */

/** Remove every SGR escape so assertions can read the visible content. */
function plain(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR escapes is the point.
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Visible width — length after ANSI is stripped. */
function vwidth(s: string): number {
  return plain(s).length;
}

describe('theme tokens', () => {
  it('exposes the full 10-colour palette as paint functions', () => {
    for (const key of [
      'ink',
      'inkDim',
      'inkFar',
      'phosphor',
      'phosphorSoft',
      'crimson',
      'amber',
      'blue',
      'purple',
      'pink',
    ] as const) {
      expect(typeof paint[key]).toBe('function');
      // identity on content — paint only adds escape bytes (or nothing).
      expect(plain(paint[key]('x'))).toBe('x');
    }
  });

  it('maps every check tone to a glyph and every verdict to a node glyph', () => {
    expect(TONE_GLYPH.ok).toBe('✓');
    expect(TONE_GLYPH.warn).toBe('⚠');
    expect(TONE_GLYPH.fail).toBe('✗');
    expect(VERDICT_GLYPH.ok).toBe('●');
    expect(VERDICT_GLYPH.fail).toBe('✕');
    expect(VERDICT_GLYPH.idle).toBe('○');
    expect(VERDICT_GLYPH.warn).toBe('!');
  });
});

describe('logo mark', () => {
  it('renders the inline mark — a node in a circle on a dotted axis', () => {
    expect(LOGO_INLINE_PLAIN).toBe('┄(●)┄');
    expect(plain(renderLogoInline())).toBe('┄(●)┄');
  });

  it('renders the block + hero marks with the node and a closed circle', () => {
    const block = plain(renderLogoBlock()).split('\n');
    expect(block).toEqual([...LOGO_BLOCK]);
    expect(block[1]).toContain('●'); // node on the axis row
    expect(block[0]).toContain('╭'); // circle top
    expect(block[2]).toContain('╯'); // circle bottom

    const hero = plain(renderLogoHero()).split('\n');
    expect(hero).toEqual([...LOGO_HERO]);
    // exactly one node, on the middle (axis) row.
    expect(hero.filter((l) => l.includes('●'))).toHaveLength(1);
    expect(hero[2]).toContain('●');
  });
});

describe('axis vocabulary', () => {
  it('renders verdict nodes with the outcome glyph', () => {
    expect(plain(axisNode('ok'))).toBe('·──●');
    expect(plain(axisNode('fail'))).toBe('·──✕');
    expect(plain(axisNode('idle'))).toBe('·──○');
    expect(plain(axisNode('warn'))).toBe('·──!');
  });

  it('builds a centred axis with balanced arms', () => {
    const { plain: p } = axisParts(41);
    const nodeIdx = p.indexOf('●');
    expect(nodeIdx).toBeGreaterThan(0);
    // arms either side of the node are equal length.
    expect(nodeIdx).toBe(p.length - 1 - nodeIdx);
    // begins and ends with the axis terminator dot.
    expect(p.startsWith('·')).toBe(true);
    expect(p.endsWith('·')).toBe(true);
  });

  it('axisDivider produces a single phosphor node on a faint axis', () => {
    expect(plain(axisDivider(30))).toContain('●');
  });
});

describe('sectionHead', () => {
  it('renders /NN + uppercase title + rule, padded to the given width', () => {
    const out = sectionHead('01', 'environment', { width: 60 });
    const p = plain(out);
    expect(p.startsWith('/01  ENVIRONMENT  ')).toBe(true);
    expect(p).toMatch(/─+$/);
    expect(vwidth(out)).toBe(60);
  });

  it('honours indent', () => {
    const out = sectionHead('02', 'services', { width: 50, indent: 2 });
    expect(plain(out).startsWith('  /02  SERVICES  ')).toBe(true);
    expect(vwidth(out)).toBe(50);
  });
});

describe('commandTitle', () => {
  it('renders a title, em-dash subtitle, and a rule on the next line', () => {
    const out = commandTitle('Doctor', 'health report', { width: 40, indent: 2 });
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(plain(lines[0] ?? '')).toBe('  Doctor — health report');
    expect(plain(lines[1] ?? '')).toMatch(/^ {2}─+$/);
  });
});

describe('kvRow / kvBlock', () => {
  it('aligns the key column and places an optional glyph + meta', () => {
    const out = kvRow(
      { glyph: checkGlyph('ok'), key: 'node.js', value: 'v22.16.0', meta: '≥ 22.16.0' },
      {
        keyWidth: 20,
      },
    );
    const p = plain(out);
    expect(p).toBe(`✓  ${'node.js'.padEnd(20)}v22.16.0  ≥ 22.16.0`);
  });

  it('reserves the glyph slot when no glyph is given so rows stay aligned', () => {
    const withGlyph = plain(kvRow({ glyph: checkGlyph('ok'), key: 'a', value: 'x' }, { keyWidth: 10 }));
    const without = plain(kvRow({ key: 'a', value: 'x' }, { keyWidth: 10 }));
    // value column starts at the same visible offset in both rows.
    expect(withGlyph.indexOf('x')).toBe(without.indexOf('x'));
  });

  it('auto-sizes the key column to the longest key', () => {
    const block = kvBlock([
      { key: 'slug', value: 'my-app' },
      { key: 'registered', value: 'yes' },
    ]);
    const lines = block.split('\n').map(plain);
    // both value columns align.
    expect(lines[0]?.indexOf('my-app')).toBe(lines[1]?.indexOf('yes'));
  });
});

describe('timelineRow', () => {
  it('renders an axis node, relative time, id, status, and meta', () => {
    const out = timelineRow({
      verdict: 'ok',
      when: '12m ago',
      id: 'run_a8f3…',
      status: 'completed',
      meta: '47 events',
    });
    const p = plain(out);
    expect(p.startsWith('·──●  ')).toBe(true);
    expect(p).toContain('12m ago');
    expect(p).toContain('run_a8f3…');
    expect(p).toContain('completed');
    expect(p).toContain('47 events');
  });

  it('uses the failure glyph for a failed run', () => {
    const out = timelineRow({ verdict: 'fail', when: '3h ago', id: 'run_9e7b…', status: 'failed' });
    expect(plain(out).startsWith('·──✕')).toBe(true);
  });
});

describe('summaryBar', () => {
  it('joins segments with a faint dot separator', () => {
    const out = summaryBar([
      { text: '20 / 20 checks passed' },
      { text: '1 warning', tone: 'amber' },
      { text: '0 failures' },
    ]);
    expect(plain(out)).toBe('20 / 20 checks passed  ·  1 warning  ·  0 failures');
  });
});

describe('banner', () => {
  it('renders the logo mark, the block wordmark, italic tagline, and version meta', () => {
    const out = banner({ version: '0.1.0-beta.8', tagline: 'Master the context.', width: 60 });
    const p = plain(out);
    expect(p).toContain('●'); // logo node
    expect(p).toContain('╭'); // logo circle
    expect(p).toContain('█'); // figlet block wordmark
    expect(p).toContain('Master the context.');
    expect(p).toContain('Coodra · v0.1.0-beta.8 · local-first by design');
  });

  it('falls back to the plain word on a terminal too narrow for the block art', () => {
    const out = banner({ version: '0.1.0-beta.8', width: 36 });
    const p = plain(out);
    expect(p).not.toContain('█');
    expect(p).toContain('coodra');
  });
});

describe('prompt + status one-liners', () => {
  it('renders the prompt as an axis node + role + separator', () => {
    expect(plain(promptLine())).toBe(`·──●  you ${glyph.promptSep} `);
    expect(plain(promptLine({ command: 'coodra status' }))).toBe(`·──●  you ${glyph.promptSep} coodra status`);
  });

  it('renders error / warn / ok one-liners with the right glyphs', () => {
    expect(plain(errorLine('boom'))).toBe('·──✕  error  boom');
    expect(plain(warnLine('careful'))).toBe('⚠  careful');
    expect(plain(okLine('all good'))).toBe('✓  all good');
  });
});

describe('footerHints', () => {
  it('renders key/label pairs separated by spacing', () => {
    const out = footerHints([
      { keys: 'tab', label: 'switch views' },
      { keys: '⏎', label: 'run' },
      { keys: 'q', label: 'quit' },
    ]);
    expect(plain(out)).toBe('tab switch views   ⏎ run   q quit');
  });
});

describe('indentLines', () => {
  it('indents non-empty lines only', () => {
    expect(indentLines('a\n\nb', 2)).toBe('  a\n\n  b');
  });
});
