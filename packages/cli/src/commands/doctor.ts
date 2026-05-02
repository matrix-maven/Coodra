import pc from 'picocolors';
import { buildCheckContext } from '../doctor/context.js';
import { formatHuman, formatJson } from '../doctor/output.js';
import { ALL_CHECKS, ESSENTIAL_CHECKS } from '../doctor/registry.js';
import { exitCodeForReport, runChecks } from '../doctor/run.js';

export interface DoctorOptions {
  readonly json?: boolean;
  readonly timeoutMs?: string;
  /**
   * Run every check in the registry, not just the 9 essentials.
   * Decision dec_83ba10c1 (2026-05-02). Default false — `contextos
   * doctor` runs the trimmed essential surface and `--full` opts in
   * to debug / team-mode / outbox observability checks.
   */
  readonly full?: boolean;
}

export interface DoctorIO {
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly exit: (code: number) => never;
}

export const DEFAULT_DOCTOR_IO: DoctorIO = {
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

export async function runDoctorCommand(options: DoctorOptions = {}, io: DoctorIO = DEFAULT_DOCTOR_IO): Promise<never> {
  const timeoutMs = parseTimeout(options.timeoutMs);
  const ctx = buildCheckContext({ timeoutMs });
  const checks = options.full === true ? ALL_CHECKS : ESSENTIAL_CHECKS;
  const report = await runChecks(checks, ctx);
  const exit = exitCodeForReport(report);

  if (options.json === true) {
    io.writeStdout(`${formatJson(report)}\n`);
  } else {
    io.writeStdout(`${formatHuman(report)}\n`);
    if (options.full !== true) {
      io.writeStdout(
        `${pc.gray(`(${ESSENTIAL_CHECKS.length} essential checks shown. Run \`contextos doctor --full\` for the complete ${ALL_CHECKS.length}-check registry.)`)}\n`,
      );
    }
    if (exit === 2) {
      io.writeStderr(`${pc.red('doctor: red findings present — fix the items above before continuing.')}\n`);
    }
  }
  return io.exit(exit);
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return 2000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 2000;
  return parsed;
}
