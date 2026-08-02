import { homedir } from 'node:os';
import { createClaudeCliRunner, probeClaudePlugin } from '../../lib/agents/claude-plugin.js';
import { probeCodexPlugin } from '../../lib/agents/codex-plugin.js';
import { defaultClaudeSettingsPath } from '../../lib/init/claude-settings-merge.js';
import type { Check } from '../types.js';

export const mcpConfigValidityCheck: Check = {
  id: 14,
  name: 'Coodra MCP config is available through a native agent plugin',
  severity: 'yellow',
  async run(ctx) {
    const native = await probeNativePluginMcp(ctx);
    if (native !== null) return native;

    return {
      status: 'yellow',
      detail: 'native Coodra plugin MCP not found',
      remediation: 'Run `coodra agent add codex` or `coodra agent add claude` to install native plugin MCP wiring.',
    };
  },
};

async function probeNativePluginMcp(
  ctx: Parameters<Check['run']>[0],
): Promise<{ status: 'green'; detail: string } | null> {
  const userHome = ctx.env.HOME || ctx.env.USERPROFILE || homedir();
  const codex = await probeCodexPlugin({ cwd: ctx.cwd, userHome });
  if (codex.mcp) {
    return { status: 'green', detail: `native Codex plugin provides Coodra MCP at ${codex.paths.mcpPath}` };
  }

  const settingsPath = defaultClaudeSettingsPath(undefined, ctx.env);
  const claude = await probeClaudePlugin(
    { cwd: ctx.cwd, userHome, settingsPath },
    createClaudeCliRunner(Math.min(ctx.timeoutMs, 1200)),
  );
  if (claude.mcp) {
    return { status: 'green', detail: `native Claude Code plugin provides Coodra MCP at ${claude.paths.cacheMcpPath}` };
  }
  return null;
}
