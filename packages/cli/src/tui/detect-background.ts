/**
 * `src/tui/detect-background.ts` — best-effort terminal background
 * detection via the OSC 11 query, used by the TUI to auto-pick the
 * light vs. dark accent set without the user setting `COODRA_THEME`.
 *
 * Why only the TUI: the TUI is interactive and owns raw stdin, so a
 * sub-150ms probe is invisible. One-shot commands stay synchronous —
 * they rely on `COLORFGBG` + the `COODRA_THEME` override + the
 * always-safe `unknown` palette, and must not pay a probe per run.
 *
 * The probe is *best-effort by construction*: it writes `ESC ] 11 ; ?`
 * and waits briefly for an `rgb:` reply. Terminals that don't support
 * OSC 11 simply ignore the query (no garbage printed) and the timeout
 * fires; anything unexpected resolves to `null`. The caller falls back
 * to the `unknown` accent set, which is already readable on any
 * background — so a failed probe costs polish, never correctness.
 */

/** Parse an OSC 11 `rgb:RRRR/GGGG/BBBB` (or `RR/GG/BB`) reply into 0–255 channels. */
function parseRgbReply(buffer: string): { r: number; g: number; b: number } | null {
  // e.g. "\x1b]11;rgb:1c1c/1c1c/1c1c\x07"  or  "...rgb:ff/ff/ff\x1b\\"
  const match = buffer.match(/\]11;rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/);
  if (match === null) return null;
  const channel = (hex: string): number => {
    // Terminals report 16-bit channels ("1c1c"); take the high byte.
    const v = Number.parseInt(hex.slice(0, 2), 16);
    return Number.isFinite(v) ? v : 0;
  };
  return { r: channel(match[1] ?? ''), g: channel(match[2] ?? ''), b: channel(match[3] ?? '') };
}

/**
 * Probe the terminal background. Resolves `'light'` / `'dark'` when the
 * terminal answers the OSC 11 query, or `null` when it doesn't (no
 * support, not a TTY, or the timeout elapses). Never throws, never
 * hangs longer than `timeoutMs`, and always restores stdin.
 */
export async function detectTerminalBackground(timeoutMs = 140): Promise<'light' | 'dark' | null> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (stdin.isTTY !== true || stdout.isTTY !== true) return null;

  return new Promise<'light' | 'dark' | null>((resolve) => {
    let settled = false;
    let buffer = '';
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: 'light' | 'dark' | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      stdin.removeListener('data', onData);
      try {
        stdin.setRawMode(false);
      } catch {
        // stdin may not support raw mode — nothing to restore.
      }
      stdin.pause();
      resolve(result);
    };

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('latin1');
      const rgb = parseRgbReply(buffer);
      if (rgb === null) {
        // Keep waiting unless the buffer is clearly not an OSC 11 reply
        // and has grown — guard against unbounded growth.
        if (buffer.length > 256) finish(null);
        return;
      }
      // Perceived luminance (Rec. 601). > 0.5 ⇒ a light background.
      const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
      finish(luminance > 0.5 ? 'light' : 'dark');
    };

    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
      // OSC 11 query — request the background colour.
      stdout.write('\x1b]11;?\x07');
    } catch {
      finish(null);
      return;
    }

    timer = setTimeout(() => finish(null), timeoutMs);
  });
}
