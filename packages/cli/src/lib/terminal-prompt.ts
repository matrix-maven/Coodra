/**
 * `lib/terminal-prompt.ts` — the one readline-backed question prompt.
 *
 * Interactive commands take an injectable `readPrompt` for tests and
 * default to this at runtime (init's team/solo + per-agent asks,
 * graphify's install offer). Extracted 2026-07-02 — identical
 * readline/promises boilerplate had accumulated per command module;
 * `team-init.ts` / `team-migrate-cmd.ts` still carry local copies and
 * should adopt this on their next touch.
 */
export async function terminalReadPrompt(question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
