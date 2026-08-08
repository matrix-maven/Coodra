import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildInstructionBlock,
  INSTRUCTION_BLOCK_END,
  INSTRUCTION_BLOCK_START,
  mergeInstructionFile,
  removeInstructionBlock,
} from '../../../src/lib/init/instruction-files.js';

/**
 * Locks the instruction-file generator contract (AGENTS.md / CLAUDE.md):
 *   1. Greenfield — absent file → created containing just the block.
 *   2. Idempotent — second merge with the same slug is 'unchanged'.
 *   3. Markers present → block content refreshed, content OUTSIDE the
 *      markers preserved byte-for-byte.
 *   4. No markers → block appended, every user line preserved.
 *   5. Dry-run writes nothing.
 *   6. removeInstructionBlock strips the block; deletes the file if it
 *      held only the block, keeps it (minus the block) otherwise.
 *   7. The block embeds the project slug.
 */

describe('mergeInstructionFile — AGENTS.md / CLAUDE.md generator', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'coodra-instr-'));
  });
  afterEach(() => {
    /* tmp cleaned by OS */
  });

  it('greenfield: creates AGENTS.md containing the marker-wrapped block', async () => {
    const result = await mergeInstructionFile({ cwd, filename: 'AGENTS.md', projectSlug: 'my-proj', dryRun: false });
    expect(result.action).toBe('wrote');
    const body = await readFile(join(cwd, 'AGENTS.md'), 'utf8');
    expect(body).toContain(INSTRUCTION_BLOCK_START);
    expect(body).toContain(INSTRUCTION_BLOCK_END);
    expect(body).toContain('my-proj');
    expect(body).toContain('coodra__get_run_id');
  });

  it('is idempotent — a second merge with the same slug is unchanged', async () => {
    await mergeInstructionFile({ cwd, filename: 'CLAUDE.md', projectSlug: 'p', dryRun: false });
    const second = await mergeInstructionFile({ cwd, filename: 'CLAUDE.md', projectSlug: 'p', dryRun: false });
    expect(second.action).toBe('unchanged');
  });

  it('refreshes the block in place, preserving content outside the markers', async () => {
    const userAbove = '# My project rules\n\nAlways use tabs.\n\n';
    const userBelow = '\n\n## My extra section\n\nDeploy on Fridays.\n';
    const stale = `${INSTRUCTION_BLOCK_START}\nold coodra content\n${INSTRUCTION_BLOCK_END}`;
    await writeFile(join(cwd, 'CLAUDE.md'), `${userAbove}${stale}${userBelow}`, 'utf8');

    const result = await mergeInstructionFile({
      cwd,
      filename: 'CLAUDE.md',
      projectSlug: 'refreshed',
      dryRun: false,
    });
    expect(result.action).toBe('merged');
    const body = await readFile(join(cwd, 'CLAUDE.md'), 'utf8');
    expect(body).toContain('Always use tabs.');
    expect(body).toContain('Deploy on Fridays.');
    expect(body).toContain('refreshed');
    expect(body).not.toContain('old coodra content');
    // Exactly one block.
    expect(body.split(INSTRUCTION_BLOCK_START).length).toBe(2);
  });

  it('appends the block to a file with no markers, preserving all user content', async () => {
    await writeFile(join(cwd, 'AGENTS.md'), '# Hand-written agent rules\n\nBe concise.\n', 'utf8');
    const result = await mergeInstructionFile({ cwd, filename: 'AGENTS.md', projectSlug: 'p', dryRun: false });
    expect(result.action).toBe('merged');
    const body = await readFile(join(cwd, 'AGENTS.md'), 'utf8');
    expect(body).toContain('Be concise.');
    expect(body).toContain(INSTRUCTION_BLOCK_START);
    expect(body.indexOf('Be concise.')).toBeLessThan(body.indexOf(INSTRUCTION_BLOCK_START));
  });

  it('dry-run writes nothing to disk', async () => {
    const result = await mergeInstructionFile({ cwd, filename: 'AGENTS.md', projectSlug: 'p', dryRun: true });
    expect(result.action).toBe('wrote');
    await expect(readFile(join(cwd, 'AGENTS.md'), 'utf8')).rejects.toThrow();
  });

  it('removeInstructionBlock deletes the file when it held only the block', async () => {
    await mergeInstructionFile({ cwd, filename: 'AGENTS.md', projectSlug: 'p', dryRun: false });
    const result = await removeInstructionBlock({ cwd, filename: 'AGENTS.md', dryRun: false });
    expect(result.action).toBe('merged');
    await expect(readFile(join(cwd, 'AGENTS.md'), 'utf8')).rejects.toThrow();
  });

  it('removeInstructionBlock keeps the file (minus the block) when it has user content', async () => {
    await writeFile(join(cwd, 'CLAUDE.md'), '# User rules\n\nUse tabs.\n', 'utf8');
    await mergeInstructionFile({ cwd, filename: 'CLAUDE.md', projectSlug: 'p', dryRun: false });
    const result = await removeInstructionBlock({ cwd, filename: 'CLAUDE.md', dryRun: false });
    expect(result.action).toBe('merged');
    const body = await readFile(join(cwd, 'CLAUDE.md'), 'utf8');
    expect(body).toContain('Use tabs.');
    expect(body).not.toContain(INSTRUCTION_BLOCK_START);
  });

  it('removeInstructionBlock is a no-op on a file with no markers', async () => {
    await writeFile(join(cwd, 'AGENTS.md'), '# Just user content\n', 'utf8');
    const result = await removeInstructionBlock({ cwd, filename: 'AGENTS.md', dryRun: false });
    expect(result.action).toBe('unchanged');
  });

  it('buildInstructionBlock embeds the slug and the core trigger-contract tools', async () => {
    const block = buildInstructionBlock('the-slug', 'AGENTS.md');
    expect(block).toContain('the-slug');
    expect(block).toContain('## Coodra Workflow Policy');
    expect(block).toContain('Instruction files such as `AGENTS.md` and `CLAUDE.md` are render targets');
    for (const tool of [
      'coodra__get_run_id',
      'coodra__work_pack_status',
      'coodra__check_policy',
      'coodra__record_decision',
      'coodra__save_context_pack',
    ]) {
      expect(block).toContain(tool);
    }
  });

  // 2026-07-02: the block is per-agent — each file pins the agentType its
  // agent must pass to get_run_id so runs never land as "unknown agent"
  // on the dashboard (the observed Codex failure: its MCP client name
  // 'codex-mcp-client' wasn't in the server's mapping table).
  it.each([
    ['CLAUDE.md', 'claude_code', 'Claude Code'],
    ['AGENTS.md', 'codex', 'Codex'],
  ] as const)('%s pins agentType "%s" and names its agent %s', (filename, agentType, displayName) => {
    const block = buildInstructionBlock('slug-x', filename);
    expect(block).toContain(`agentType: "${agentType}"`);
    expect(block).toContain(displayName);
  });

  // 2026-07-12: the pinned agentType is a default, not a hard rule — an
  // agent reading a file generated for a different client (e.g. Claude
  // Code reading AGENTS.md) must pass its OWN type, so the block carries
  // an explicit cross-agent caveat instead of 'ALWAYS pass'.
  it('AGENTS.md output carries the cross-agent caveat (pass YOUR own agentType)', async () => {
    await mergeInstructionFile({ cwd, filename: 'AGENTS.md', projectSlug: 'x-agent', dryRun: false });
    const body = await readFile(join(cwd, 'AGENTS.md'), 'utf8');
    expect(body).toContain('This file was generated for Codex.');
    expect(body).toContain('pass YOUR own type instead');
    expect(body).toContain('`"claude_code" | "codex"`');
    expect(body).not.toContain('ALWAYS pass');
  });

  it('only CLAUDE.md carries the agentSessionId (SessionStart hook reconciliation) hint', () => {
    expect(buildInstructionBlock('s', 'CLAUDE.md')).toContain('agentSessionId');
    expect(buildInstructionBlock('s', 'AGENTS.md')).not.toContain('agentSessionId');
  });

  it('renders team workflow policy into managed instruction blocks', () => {
    const block = buildInstructionBlock('team-project', 'CLAUDE.md', {
      enabled: true,
      profile: 'team',
      requireBranch: true,
      requireDecisionLog: true,
      requireContextPack: true,
      requireTests: true,
      requireCommit: true,
      requirePush: true,
      requirePrLink: true,
      allowAutoMerge: false,
      updateWorkPackOnCompletion: true,
    });
    expect(block).toContain('Team mode: create a branch, push it, open a PR for review, and do not auto-merge.');
    expect(block).toContain('- Link or create a PR before completion: yes');
    expect(block).toContain('- Auto-merge permitted after passing tests: no');
  });

  it('preserves user content above an existing CLAUDE.md when appending the block', async () => {
    // Common case: the user already has a CLAUDE.md (Anthropic's
    // documented per-project memory file). Appending the Coodra block
    // must NOT touch anything above the marker.
    const userContent = '# Project context\n\n@docs/architecture.md\n@docs/conventions.md\n';
    await writeFile(join(cwd, 'CLAUDE.md'), userContent, 'utf8');
    const result = await mergeInstructionFile({ cwd, filename: 'CLAUDE.md', projectSlug: 'p', dryRun: false });
    expect(result.action).toBe('merged');
    const body = await readFile(join(cwd, 'CLAUDE.md'), 'utf8');
    expect(body).toContain('@docs/architecture.md');
    expect(body).toContain('@docs/conventions.md');
    expect(body.indexOf('@docs/architecture.md')).toBeLessThan(body.indexOf(INSTRUCTION_BLOCK_START));
  });

  it('removeInstructionBlock strips the block from AGENTS.md', async () => {
    await mergeInstructionFile({ cwd, filename: 'AGENTS.md', projectSlug: 'p', dryRun: false });
    const result = await removeInstructionBlock({ cwd, filename: 'AGENTS.md', dryRun: false });
    expect(result.action).toBe('merged');
    await expect(readFile(join(cwd, 'AGENTS.md'), 'utf8')).rejects.toThrow();
  });
});
