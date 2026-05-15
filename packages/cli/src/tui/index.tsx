/**
 * `src/tui/index.tsx` — entry point for the interactive Coodra
 * terminal UI. Launched by `coodra` with no arguments (when stdout
 * is a TTY) and by the explicit `coodra ui` command.
 *
 * Kept behind a dynamic `import()` from `program.ts` so React + Ink
 * never load on the hot path of a one-shot command — `coodra
 * status` and friends pay nothing for the TUI existing.
 */

import { render } from 'ink';
import { activeColorScheme, setColorScheme } from '../ui/theme.js';
import { App } from './App.js';
import { loadTuiContext } from './context.js';
import { detectTerminalBackground } from './detect-background.js';

/**
 * Boot the TUI. Requires an interactive terminal — in a non-TTY
 * context (pipe, CI, `coodra | cat`) it prints a hint and sets a
 * non-zero exit code instead of rendering a UI nothing can drive.
 */
export async function launchTui(): Promise<void> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    process.stderr.write(
      'coodra: the interactive UI needs an interactive terminal (TTY).\n' +
        '  Run a command directly instead — e.g. `coodra status` or `coodra --help`.\n',
    );
    process.exitCode = 1;
    return;
  }

  // Auto-adapt the accent palette to the terminal background. Only when
  // the synchronous detection (COODRA_THEME / COLORFGBG) came back
  // `unknown` — an explicit override or COLORFGBG hint always wins. The
  // probe is best-effort: on failure the `unknown` palette stands, which
  // is already readable on any background.
  if (activeColorScheme === 'unknown') {
    const detected = await detectTerminalBackground();
    if (detected !== null) setColorScheme(detected);
  }

  const ctx = await loadTuiContext();
  const app = render(<App ctx={ctx} />);
  await app.waitUntilExit();
  // Ink has restored the terminal and flushed by the time waitUntilExit
  // resolves; exit explicitly so a stray open handle can't keep the
  // process alive after the user quit.
  process.exit(0);
}
