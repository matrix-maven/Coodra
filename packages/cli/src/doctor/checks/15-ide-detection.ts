import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Check } from '../types.js';

const IDE_DIRS = [
  { name: 'Claude Code', dir: '.claude' },
  { name: 'Codex', dir: '.codex' },
];

export const ideDetectionCheck: Check = {
  id: 15,
  name: 'IDE detection (~/.claude, ~/.codex)',
  severity: 'yellow',
  async run(_ctx) {
    const home = homedir();
    const found: string[] = [];
    for (const ide of IDE_DIRS) {
      try {
        await access(join(home, ide.dir));
        found.push(ide.name);
      } catch {
        // not installed
      }
    }
    if (found.length > 0) {
      return { status: 'green', detail: `detected: ${found.join(', ')}` };
    }
    return {
      status: 'yellow',
      detail: 'no supported IDE config directory found in $HOME',
      remediation: 'Install Claude Code or Codex — hooks need an IDE to fire from.',
    };
  },
};
