import { access, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { Check } from '../types.js';

const mcpConfigSchema = z.object({
  mcpServers: z
    .record(
      z.string(),
      z.object({
        command: z.string(),
        args: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

export const mcpConfigValidityCheck: Check = {
  id: 14,
  name: '.mcp.json parses + Coodra entry command path resolves',
  severity: 'yellow',
  async run(ctx) {
    const path = join(ctx.cwd, '.mcp.json');
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          status: 'yellow',
          detail: `.mcp.json not found at ${path}`,
          remediation: 'Run `coodra init` to write a baseline .mcp.json.',
        };
      }
      return { status: 'yellow', detail: `cannot read .mcp.json: ${(err as Error).message}` };
    }
    let parsed: z.infer<typeof mcpConfigSchema>;
    try {
      parsed = mcpConfigSchema.parse(JSON.parse(raw));
    } catch (err) {
      return {
        status: 'yellow',
        detail: `.mcp.json invalid: ${(err as Error).message}`,
        remediation: 'Re-run `coodra init` to rewrite a valid .mcp.json.',
      };
    }
    const entry = parsed.mcpServers?.coodra;
    if (entry === undefined) {
      return {
        status: 'yellow',
        detail: '.mcp.json has no `coodra` entry under mcpServers',
        remediation: 'Run `coodra init` to add the Coodra MCP server entry.',
      };
    }
    const cmd = entry.command;
    if (cmd === 'npx') {
      return {
        status: 'yellow',
        detail:
          ".mcp.json `coodra.command` is `npx` — npx-cache paths can be GC'd unexpectedly. " +
          '(Init no longer emits this fallback as of dec_83ba10c1; this entry was likely written by a pre-0.1 init or hand-edited.)',
        remediation: 'Re-run `coodra init` to overwrite the entry with the bundled `node <abs-path>` form.',
      };
    }
    // dec_83ba10c1: init now resolves to an absolute path inside the
    // bundled `@coodra/cli/dist/runtime/mcp-server/index.js`. Verify
    // the args[0] also points at a real file (the entry's `command` is
    // `node`; the binary is in args[0]).
    if (cmd === 'node' && Array.isArray(entry.args) && entry.args.length > 0) {
      const binArg = entry.args[0];
      if (typeof binArg === 'string' && isAbsolute(binArg)) {
        try {
          await access(binArg);
          return { status: 'green', detail: `.mcp.json valid; mcp-server bundle at ${binArg}` };
        } catch {
          return {
            status: 'yellow',
            detail: `.mcp.json points at ${binArg} but that path is not present`,
            remediation: 'Run `coodra init` to update .mcp.json with the current install path.',
          };
        }
      }
    }
    if (isAbsolute(cmd)) {
      try {
        await access(cmd);
      } catch {
        return {
          status: 'yellow',
          detail: `.mcp.json points at ${cmd} but that path is not present`,
          remediation: 'Run `coodra init` to update .mcp.json with the current install path.',
        };
      }
    }
    return { status: 'green', detail: `.mcp.json valid; Coodra entry command=${cmd}` };
  },
};
