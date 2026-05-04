import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MarkdownRenderer } from '@/components/MarkdownRenderer';

afterEach(cleanup);

const FIXTURE_PATH = join(__dirname, '..', '..', '__fixtures__', 'markdown-xss.md');
const HOSTILE = readFileSync(FIXTURE_PATH, 'utf8');

describe('MarkdownRenderer — XSS hardening (S4)', () => {
  it('strips <script> tags entirely (script body remains as inert text — that is correct sanitization)', () => {
    const { container } = render(<MarkdownRenderer body={HOSTILE} />);
    // The defence is: NO executable script element survives. The text
    // content from inside a stripped <script> may remain as plain text
    // — that's harmless because it isn't executable.
    expect(container.querySelectorAll('script').length).toBe(0);
  });

  it('rewrites javascript: URLs in <a href> to inert', () => {
    const { container } = render(<MarkdownRenderer body={HOSTILE} />);
    const anchors = container.querySelectorAll('a');
    for (const a of anchors) {
      const href = a.getAttribute('href') ?? '';
      expect(href.toLowerCase().startsWith('javascript:')).toBe(false);
    }
  });

  it('strips on*= event-handler attributes from any element', () => {
    const { container } = render(<MarkdownRenderer body={HOSTILE} />);
    const all = container.querySelectorAll('*');
    for (const el of all) {
      for (const attr of el.attributes) {
        expect(attr.name.toLowerCase().startsWith('on')).toBe(false);
      }
    }
  });

  it('strips <iframe>, <form>, <meta> entirely', () => {
    const { container } = render(<MarkdownRenderer body={HOSTILE} />);
    expect(container.querySelectorAll('iframe').length).toBe(0);
    expect(container.querySelectorAll('form').length).toBe(0);
    expect(container.querySelectorAll('meta').length).toBe(0);
  });

  it('strips inline <script> nested inside <svg>', () => {
    const { container } = render(<MarkdownRenderer body={HOSTILE} />);
    const svgs = container.querySelectorAll('svg');
    for (const svg of svgs) {
      expect(svg.querySelectorAll('script').length).toBe(0);
    }
  });

  it('rewrites data: URLs in <a href> to inert (or strips them)', () => {
    const { container } = render(<MarkdownRenderer body={HOSTILE} />);
    const anchors = container.querySelectorAll('a');
    for (const a of anchors) {
      const href = a.getAttribute('href') ?? '';
      expect(href.toLowerCase().startsWith('data:text/html')).toBe(false);
    }
  });

  it('preserves safe content — bold / italic / inline code / real links / fenced code / tables', () => {
    const { container } = render(<MarkdownRenderer body={HOSTILE} />);
    const html = container.innerHTML;
    expect(html).toContain('<strong');
    expect(html).toContain('<em');
    expect(html).toContain('<code');
    expect(html).toContain('https://example.com');
    expect(container.querySelectorAll('table').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('pre').length).toBeGreaterThan(0);
  });

  it('renders headings as font-display semibold (refined sentence-case, no uppercase)', () => {
    const minimal = '# Top heading\n\n## Second heading\n\n### Third heading\n';
    const { container } = render(<MarkdownRenderer body={minimal} />);
    const h1 = container.querySelector('h1');
    const h2 = container.querySelector('h2');
    const h3 = container.querySelector('h3');
    expect(h1?.className).toContain('font-display');
    expect(h1?.className).toContain('font-semibold');
    expect(h1?.className).not.toContain('uppercase');
    expect(h2?.className).toContain('font-display');
    expect(h2?.className).toContain('font-semibold');
    expect(h3?.className).toContain('font-display');
    expect(h3?.className).toContain('font-semibold');
  });

  it('renders inline code with mono font + bordered background', () => {
    const minimal = 'Use `pnpm` to install.';
    const { container } = render(<MarkdownRenderer body={minimal} />);
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code?.className).toContain('font-mono');
    expect(code?.className).toContain('border');
  });

  it('renders code blocks inside <pre> with mono font', () => {
    const minimal = '```ts\nconst x = 1;\n```\n';
    const { container } = render(<MarkdownRenderer body={minimal} />);
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.className).toContain('font-mono');
  });

  it('renders GFM tables (remark-gfm enabled)', () => {
    const minimal = '| h1 | h2 |\n|----|----|\n| a  | 1  |\n';
    const { container } = render(<MarkdownRenderer body={minimal} />);
    expect(container.querySelectorAll('table').length).toBe(1);
    expect(container.querySelectorAll('th').length).toBe(2);
    expect(container.querySelectorAll('td').length).toBe(2);
  });

  it('renders the markdown-renderer wrapper for grep-ability', () => {
    const { getByTestId } = render(<MarkdownRenderer body="hello" />);
    expect(getByTestId('markdown-renderer')).toBeDefined();
  });
});
