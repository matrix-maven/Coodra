import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { AxisNode } from '../../../src/ui/ink/AxisNode.js';
import { Banner } from '../../../src/ui/ink/Banner.js';
import { BrandMark } from '../../../src/ui/ink/BrandMark.js';
import { CommandRow } from '../../../src/ui/ink/CommandRow.js';
import { Divider } from '../../../src/ui/ink/Divider.js';
import { Footer } from '../../../src/ui/ink/Footer.js';
import { KeyValueRow } from '../../../src/ui/ink/KeyValueRow.js';
import { Prompt } from '../../../src/ui/ink/Prompt.js';
import { SectionHead } from '../../../src/ui/ink/SectionHead.js';
import { StatusDot } from '../../../src/ui/ink/StatusDot.js';
import { SummaryBar } from '../../../src/ui/ink/SummaryBar.js';
import { TimelineRow } from '../../../src/ui/ink/TimelineRow.js';
import { TopBar } from '../../../src/ui/ink/TopBar.js';

/**
 * Render-level contract for the Ink component library. `lastFrame()`
 * gives the visible terminal output; assertions strip ANSI and read the
 * glyphs / words / layout the design reference specifies.
 */

function plain(s: string | undefined): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR escapes.
  return (s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}

describe('<BrandMark>', () => {
  it('renders the inline logo mark — a node in a circle on a dotted axis', () => {
    expect(plain(render(<BrandMark variant="inline" />).lastFrame())).toBe('┄(●)┄');
  });

  it('renders the block + hero marks as a circle with the node on its axis', () => {
    const block = plain(render(<BrandMark variant="block" />).lastFrame());
    expect(block.split('\n')).toHaveLength(3);
    expect(block).toContain('●');
    expect(block).toContain('╭');

    const hero = plain(render(<BrandMark variant="hero" />).lastFrame());
    expect(hero.split('\n')).toHaveLength(5);
    expect(hero).toContain('●');
  });
});

describe('<AxisNode> / <StatusDot>', () => {
  it('renders verdict glyphs on the axis', () => {
    expect(plain(render(<AxisNode verdict="ok" />).lastFrame())).toBe('·──●');
    expect(plain(render(<AxisNode verdict="fail" />).lastFrame())).toBe('·──✕');
    expect(plain(render(<AxisNode verdict="idle" />).lastFrame())).toBe('·──○');
  });

  it('StatusDot renders the bare verdict glyph', () => {
    expect(plain(render(<StatusDot verdict="ok" />).lastFrame())).toBe('●');
    expect(plain(render(<StatusDot verdict="warn" />).lastFrame())).toBe('!');
  });
});

describe('<SectionHead>', () => {
  it('renders /NN + uppercase title + a rule, padded to width', () => {
    const frame = plain(render(<SectionHead num="01" title="environment" width={50} />).lastFrame());
    expect(frame.startsWith('/01  ENVIRONMENT  ')).toBe(true);
    expect(frame).toMatch(/─+$/);
    expect(frame.length).toBe(50);
  });
});

describe('<TopBar>', () => {
  it('renders the brand, wordmark, version, tabs, and state', () => {
    const frame = plain(
      render(
        <TopBar
          tabs={[
            { key: 'terminal', num: '01', label: 'terminal' },
            { key: 'commands', num: '02', label: 'commands' },
            { key: 'status', num: '03', label: 'status' },
          ]}
          activeKey="terminal"
          version="0.1.0-beta.8"
          stateLabel="solo · my-awesome-app"
          stateVerdict="ok"
        />,
      ).lastFrame(),
    );
    expect(frame).toContain('coodra');
    expect(frame).toContain('v0.1.0-beta.8');
    expect(frame).toContain('/01 terminal');
    expect(frame).toContain('/02 commands');
    expect(frame).toContain('/03 status');
    expect(frame).toContain('solo · my-awesome-app');
  });
});

describe('<Footer>', () => {
  it('renders key/label hint pairs', () => {
    const frame = plain(
      render(
        <Footer
          hints={[
            { keys: 'tab', label: 'switch views' },
            { keys: 'q', label: 'quit' },
          ]}
        />,
      ).lastFrame(),
    );
    expect(frame).toContain('tab switch views');
    expect(frame).toContain('q quit');
  });
});

describe('<KeyValueRow>', () => {
  it('renders a glyph, aligned label, value, and meta', () => {
    const frame = plain(
      render(<KeyValueRow tone="ok" label="node.js" value="v22.16.0" meta="≥ 22.16.0" labelWidth={20} />).lastFrame(),
    );
    expect(frame).toContain('✓');
    expect(frame).toContain('node.js');
    expect(frame).toContain('v22.16.0');
    expect(frame).toContain('≥ 22.16.0');
  });
});

describe('<TimelineRow>', () => {
  it('renders an axis node, time, id, status, and meta', () => {
    const frame = plain(
      render(
        <TimelineRow verdict="ok" when="12m ago" id="run_a8f3…" status="completed" meta="47 events" />,
      ).lastFrame(),
    );
    expect(frame.startsWith('·──●')).toBe(true);
    expect(frame).toContain('12m ago');
    expect(frame).toContain('run_a8f3…');
    expect(frame).toContain('completed');
    expect(frame).toContain('47 events');
  });
});

describe('<CommandRow>', () => {
  it('shows the cursor + bold name when active', () => {
    const active = plain(
      render(<CommandRow active name="coodra init" description="Set up Coodra" />).lastFrame(),
    );
    expect(active).toContain('▸');
    expect(active).toContain('coodra init');
    const idle = plain(
      render(<CommandRow active={false} name="coodra stop" description="Stop daemons" />).lastFrame(),
    );
    expect(idle).not.toContain('▸');
    expect(idle).toContain('coodra stop');
  });
});

describe('<SummaryBar>', () => {
  it('joins segments with a dot separator', () => {
    const frame = plain(
      render(
        <SummaryBar segments={[{ text: '42 total runs' }, { text: '47 allow' }, { text: '2 deny' }]} />,
      ).lastFrame(),
    );
    expect(frame).toBe('42 total runs  ·  47 allow  ·  2 deny');
  });
});

describe('<Banner>', () => {
  it('renders the hero axis, the block wordmark, tagline, and version', () => {
    const frame = plain(render(<Banner version="0.1.0-beta.8" tagline="Master the context." />).lastFrame());
    expect(frame).toContain('●');
    expect(frame).toContain('█'); // figlet block wordmark (100-col test stdout fits it)
    expect(frame).toContain('Master the context.');
    expect(frame).toContain('v0.1.0-beta.8');
  });
});

describe('<Prompt>', () => {
  it('renders the axis prompt with role and optional command echo', () => {
    // Ink trims trailing whitespace from a frame, so the bare prompt has no trailing space.
    expect(plain(render(<Prompt />).lastFrame())).toBe('·──●  you ›');
    expect(plain(render(<Prompt command="coodra status" />).lastFrame())).toBe('·──●  you › coodra status');
  });
});

describe('<Divider>', () => {
  it('renders a centred phosphor node on a faint axis', () => {
    const frame = plain(render(<Divider width={30} />).lastFrame());
    expect(frame).toContain('●');
    expect(frame.startsWith('·')).toBe(true);
    expect(frame.endsWith('·')).toBe(true);
  });
});
