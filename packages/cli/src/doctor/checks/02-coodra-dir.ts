import { access, constants, stat } from 'node:fs/promises';
import type { Check } from '../types.js';

export const coodraDirCheck: Check = {
  id: 2,
  name: '~/.coodra/ exists, writable, mode 0700',
  severity: 'red',
  async run(ctx) {
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(ctx.coodraHome);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          status: 'red',
          detail: `${ctx.coodraHome} does not exist`,
          remediation: 'Run `coodra init` to create the Coodra home directory.',
        };
      }
      return {
        status: 'red',
        detail: `stat ${ctx.coodraHome}: ${(err as Error).message}`,
        remediation: 'Check filesystem permissions on the parent directory.',
      };
    }

    if (!st.isDirectory()) {
      return {
        status: 'red',
        detail: `${ctx.coodraHome} exists but is not a directory`,
        remediation: 'Move or rename the file at that path, then run `coodra init`.',
      };
    }

    try {
      await access(ctx.coodraHome, constants.W_OK);
    } catch {
      return {
        status: 'red',
        detail: `${ctx.coodraHome} is not writable`,
        remediation: `\`chmod 0700 ${ctx.coodraHome}\` and ensure the current user owns it.`,
      };
    }

    if (ctx.platform !== 'win32') {
      // POSIX mode bits — Windows lacks meaningful POSIX permissions.
      const mode = st.mode & 0o777;
      if (mode !== 0o700) {
        return {
          status: 'yellow',
          detail: `mode is 0${mode.toString(8)}, expected 0700`,
          remediation: `\`chmod 0700 ${ctx.coodraHome}\` to lock down permissions.`,
        };
      }
    }
    return { status: 'green', detail: `${ctx.coodraHome} ready` };
  },
};
