import { EXIT_USER_ACTION_REQUIRED } from '../exit-codes.js';
import { pc } from '../ui/index.js';

const NOT_GA_MESSAGE =
  'team mode not yet generally available — the OAuth round-trip + ~/.coodra/config.json secret-write ' +
  'land when team mode is reachable end-to-end (post-Module 04). Track via context_memory/pending-user-actions.md.';

export interface TeamCommandIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_TEAM_IO: TeamCommandIO = {
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

export interface TeamLoginOptions {
  readonly token?: string;
  readonly server?: string;
}

export async function runTeamLoginCommand(
  _options: TeamLoginOptions = {},
  io: TeamCommandIO = DEFAULT_TEAM_IO,
): Promise<never> {
  io.writeStderr(`${pc.yellow('coodra team login')}: ${NOT_GA_MESSAGE}\n`);
  return io.exit(EXIT_USER_ACTION_REQUIRED);
}

export async function runTeamLogoutCommand(io: TeamCommandIO = DEFAULT_TEAM_IO): Promise<never> {
  io.writeStderr(`${pc.yellow('coodra team logout')}: ${NOT_GA_MESSAGE}\n`);
  return io.exit(EXIT_USER_ACTION_REQUIRED);
}
