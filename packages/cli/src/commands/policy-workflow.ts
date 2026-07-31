import { EXIT_OK, EXIT_USER_RECOVERABLE } from '../exit-codes.js';
import { type InstructionFileName, mergeInstructionFile } from '../lib/init/instruction-files.js';
import { readProjectConfig } from '../lib/project-store/config.js';
import { commandTitle, pc, terminalWidth } from '../ui/index.js';

export interface PolicyWorkflowRenderOptions {
  readonly cwd?: string;
  readonly agents?: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

export interface PolicyWorkflowIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_POLICY_WORKFLOW_IO: PolicyWorkflowIO = {
  writeStdout: (chunk) => {
    process.stdout.write(chunk);
  },
  writeStderr: (chunk) => {
    process.stderr.write(chunk);
  },
  exit: (code) => {
    process.exit(code);
  },
};

const AGENT_FILES: Readonly<Record<string, InstructionFileName>> = {
  codex: 'AGENTS.md',
  claude: 'CLAUDE.md',
  claude_code: 'CLAUDE.md',
};

export async function runPolicyWorkflowRenderCommand(
  options: PolicyWorkflowRenderOptions,
  io: PolicyWorkflowIO = DEFAULT_POLICY_WORKFLOW_IO,
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const json = options.json === true;
  const cfg = await readProjectConfig(cwd);
  if (cfg === null) {
    return surfaceError(io, json, `No .coodra/config.json found at ${cwd}. Run \`coodra init\` first.`);
  }

  const outcomes = [];
  for (const filename of parseAgents(options.agents ?? 'codex,claude')) {
    outcomes.push(
      await mergeInstructionFile({
        cwd,
        filename,
        projectSlug: cfg.projectSlug,
        ...(cfg.workflowPolicy !== undefined ? { workflowPolicy: cfg.workflowPolicy } : {}),
        dryRun: options.dryRun === true,
      }),
    );
  }

  if (json) {
    io.writeStdout(`${JSON.stringify({ ok: true, projectSlug: cfg.projectSlug, outcomes }, null, 2)}\n`);
  } else {
    io.writeStdout(`${commandTitle('Workflow Policy', cfg.projectSlug, { width: terminalWidth() })}\n`);
    for (const outcome of outcomes) {
      io.writeStdout(`  ${pc.green('~')} ${outcome.path} ${pc.dim(`(${outcome.notes ?? outcome.action})`)}\n`);
    }
  }
  io.exit(EXIT_OK);
}

function parseAgents(raw: string): InstructionFileName[] {
  const files = new Set<InstructionFileName>();
  for (const token of raw.split(',').map((part) => part.trim().toLowerCase())) {
    const file = AGENT_FILES[token];
    if (file !== undefined) files.add(file);
  }
  return files.size > 0 ? [...files] : ['AGENTS.md', 'CLAUDE.md'];
}

function surfaceError(io: PolicyWorkflowIO, json: boolean, message: string): void {
  if (json) {
    io.writeStdout(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  } else {
    io.writeStderr(`${pc.red('error')}: ${message}\n`);
  }
  io.exit(EXIT_USER_RECOVERABLE);
}
