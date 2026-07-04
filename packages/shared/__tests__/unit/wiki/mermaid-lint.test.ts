import { describe, expect, it } from 'vitest';
import { extractMermaidBlocks, lintMarkdownMermaid, lintMermaid } from '../../../src/wiki/mermaid-lint.js';

/**
 * Locks the structural Mermaid lint (Module 10, 2026-07-02) that
 * `wiki_save_page` runs at the MCP boundary. Positive cases mirror
 * diagrams agents legitimately author; negative cases mirror the
 * breakages observed in real wiki runs (unquoted parens in flowchart
 * labels, missing `end`, unbalanced brackets, unknown diagram type).
 */

describe('extractMermaidBlocks', () => {
  it('extracts fenced blocks with their markdown line numbers', () => {
    const md = [
      '# Title',
      '',
      '```mermaid',
      'flowchart TD',
      '  A --> B',
      '```',
      'text',
      '```mermaid',
      'pie',
      '```',
    ].join('\n');
    const blocks = extractMermaidBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.code).toBe('flowchart TD\n  A --> B');
    expect(blocks[0]?.fenceLine).toBe(3);
    expect(blocks[1]?.fenceLine).toBe(8);
  });

  it('ignores non-mermaid code fences', () => {
    const md = '```ts\nconst x = 1;\n```\n';
    expect(extractMermaidBlocks(md)).toHaveLength(0);
  });

  it('surfaces an unclosed mermaid fence as a block (so the lint sees it)', () => {
    const md = '```mermaid\nflowchart TD\n  A --> B';
    expect(extractMermaidBlocks(md)).toHaveLength(1);
  });
});

describe('lintMermaid — diagrams that must pass', () => {
  it.each([
    ['flowchart', 'flowchart TD\n  A[Start] --> B{Choice}\n  B -->|yes| C[Done]'],
    ['flowchart with quoted parens label', 'flowchart LR\n  A["calls fn(x)"] --> B'],
    [
      'flowchart cylinder + stadium shapes',
      'flowchart TD\n  D[(Database)] --> S([Stadium])\n  C((Circle)) --> E[[Sub]]',
    ],
    ['subgraph pairs', 'flowchart TD\n  subgraph one\n    A --> B\n  end\n  subgraph two\n    C\n  end'],
    [
      'sequence with alt/end',
      'sequenceDiagram\n  participant A\n  alt happy\n    A->>B: hi\n  else sad\n    A->>B: bye\n  end',
    ],
    ['class diagram', 'classDiagram\n  class Animal {\n    +String name\n    +speak() void\n  }\n  Animal <|-- Dog'],
    ['er diagram', 'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER {\n    string id\n  }'],
    ['state diagram', 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy'],
    ['pie', 'pie title Languages\n  "ts" : 70\n  "py" : 30'],
    ['init directive first', '%%{init: {"theme": "dark"}}%%\nflowchart TD\n  A --> B'],
    ['comments', 'flowchart TD\n  %% a comment with (parens) [brackets]\n  A --> B'],
  ])('%s', (_name, code) => {
    expect(lintMermaid(code)).toEqual([]);
  });
});

describe('lintMermaid — diagrams that must fail', () => {
  it('flags an empty block', () => {
    expect(lintMermaid('  \n  ')).toEqual([{ line: 1, message: expect.stringContaining('empty') }]);
  });

  it('flags an unknown diagram type', () => {
    const issues = lintMermaid('flowchat TD\n  A --> B');
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('unknown diagram type');
  });

  it('flags the classic unquoted-parens flowchart label', () => {
    const issues = lintMermaid('flowchart TD\n  A[calls fn(x)] --> B');
    expect(issues.some((i) => i.message.includes('wrap the label text in double quotes'))).toBe(true);
  });

  it('flags unbalanced brackets', () => {
    const issues = lintMermaid('flowchart TD\n  A[oops --> B');
    expect(issues.some((i) => i.message.includes('unclosed "["'))).toBe(true);
  });

  it('flags a stray closing bracket', () => {
    const issues = lintMermaid('sequenceDiagram\n  A->>B: hi)');
    expect(issues.some((i) => i.message.includes('unbalanced ")"'))).toBe(true);
  });

  it('flags a subgraph without end', () => {
    const issues = lintMermaid('flowchart TD\n  subgraph core\n    A --> B');
    expect(issues.some((i) => i.message.includes('missing "end"'))).toBe(true);
  });

  it('flags an end with no open block', () => {
    const issues = lintMermaid('flowchart TD\n  A --> B\n  end');
    expect(issues.some((i) => i.message.includes('no open subgraph'))).toBe(true);
  });

  it('ignores brackets inside quoted strings when balancing', () => {
    expect(lintMermaid('flowchart TD\n  A["(((["] --> B')).toEqual([]);
  });
});

describe('lintMarkdownMermaid', () => {
  it('reports issues with block index and absolute markdown line', () => {
    const md = ['intro', '', '```mermaid', 'flowchart TD', '  A[fn(x)] --> B', '```'].join('\n');
    const result = lintMarkdownMermaid(md);
    expect(result.blockCount).toBe(1);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.blockIndex).toBe(0);
    expect(result.issues[0]?.markdownLine).toBe(5);
  });

  it('returns zero issues and the block count for clean markdown', () => {
    const md = '# Page\n\n```mermaid\nflowchart TD\n  A --> B\n```\n';
    expect(lintMarkdownMermaid(md)).toEqual({ blockCount: 1, issues: [] });
  });

  it('counts zero blocks when the page has no diagrams', () => {
    expect(lintMarkdownMermaid('# Page\n\nprose only\n')).toEqual({ blockCount: 0, issues: [] });
  });
});
