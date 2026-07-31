import { describe, expect, it } from 'vitest';
import { parseJiraWorkIntent, renderJiraWorkModeContext } from '../../src/work-intent.js';

describe('parseJiraWorkIntent', () => {
  it('parses explicit slash-style jira work prompts', () => {
    expect(parseJiraWorkIntent('/coodra-jira-work COOD-10 --related')).toEqual({
      issueKey: 'COOD-10',
      slug: 'cood-10',
      withRelated: true,
    });
  });

  it('parses natural work prompts with a Jira key', () => {
    expect(parseJiraWorkIntent({ prompt: 'Let us work on COOD-12 with related subtasks' })).toEqual({
      issueKey: 'COOD-12',
      slug: 'cood-12',
      withRelated: true,
    });
  });

  it('ignores unrelated Jira mentions', () => {
    expect(parseJiraWorkIntent('What is the status of COOD-10?')).toBeNull();
  });
});

describe('renderJiraWorkModeContext', () => {
  it('tells the agent to own import, context-pack linking, and implementation', () => {
    const text = renderJiraWorkModeContext({ issueKey: 'COOD-10', slug: 'cood-10', withRelated: true });
    expect(text).toContain('Coodra Work Pack mode: COOD-10');
    expect(text).toContain('coodra__work_pack_upsert');
    expect(text).toContain('workPackSlug');
    expect(text).toContain('Do not ask the user to run a second import command');
  });
});
