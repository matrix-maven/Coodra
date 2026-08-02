import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const GRAPHIFY_LLM_ENV_KEYS = [
  'GRAPHIFY_BACKEND',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'KIMI_API_KEY',
  'MOONSHOT_API_KEY',
] as const;

const GRAPHIFY_LLM_ENV_HELP: Record<(typeof GRAPHIFY_LLM_ENV_KEYS)[number], string> = {
  GRAPHIFY_BACKEND: 'claude',
  ANTHROPIC_API_KEY: '',
  OPENAI_API_KEY: '',
  GEMINI_API_KEY: '',
  GOOGLE_API_KEY: '',
  DEEPSEEK_API_KEY: '',
  KIMI_API_KEY: '',
  MOONSHOT_API_KEY: '',
};

const GRAPHIFY_LLM_ENV_HEADER = [
  '# Graphify semantic build backend (optional)',
  '# GRAPHIFY_BACKEND selects the provider/client; the matching API key authenticates it.',
  '# Examples:',
  '#   GRAPHIFY_BACKEND=claude   needs ANTHROPIC_API_KEY=...',
  '#   GRAPHIFY_BACKEND=openai   needs OPENAI_API_KEY=...',
  '#   GRAPHIFY_BACKEND=gemini   needs GEMINI_API_KEY=... or GOOGLE_API_KEY=...',
  '#   GRAPHIFY_BACKEND=deepseek needs DEEPSEEK_API_KEY=...',
  '#   GRAPHIFY_BACKEND=kimi     needs KIMI_API_KEY=... or MOONSHOT_API_KEY=...',
  '#   GRAPHIFY_BACKEND=ollama   needs a local Ollama server, usually no API key.',
  '# Uncomment one backend and the matching key for semantic `coodra graphify build`.',
  '# Without these, use `coodra graphify build --no-llm` for a structural graph.',
] as const;

/**
 * Seed commented Graphify semantic-backend placeholders in ~/.coodra/.env.
 *
 * They are comments on purpose: active blank variables can shadow real shell
 * credentials. The user can uncomment exactly the backend/key they want.
 */
export function ensureGraphifyLlmEnvTemplate(envPath: string): boolean {
  let existing = '';
  if (existsSync(envPath)) {
    try {
      existing = readFileSync(envPath, 'utf8');
    } catch {
      existing = '';
    }
  }

  const missing = GRAPHIFY_LLM_ENV_KEYS.filter((key) => !new RegExp(`^#?\\s*${key}=`, 'm').test(existing));
  if (missing.length === 0) return false;

  const upgraded = upgradeGraphifyHeader(existing);
  const lines = upgraded.trimEnd().length > 0 ? [upgraded.trimEnd(), ''] : [];
  if (!/^# Graphify semantic build backend/m.test(existing)) {
    lines.push(...GRAPHIFY_LLM_ENV_HEADER);
  }
  for (const key of missing) {
    lines.push(`# ${key}=${GRAPHIFY_LLM_ENV_HELP[key]}`);
  }

  mkdirSync(dirname(envPath), { recursive: true });
  const tmpPath = `${envPath}.tmp`;
  writeFileSync(tmpPath, `${lines.join('\n')}\n`, 'utf8');
  renameSync(tmpPath, envPath);
  return true;
}

function upgradeGraphifyHeader(existing: string): string {
  if (!/^# Graphify semantic build backend/m.test(existing)) return existing;
  const lines = existing.split('\n');
  const start = lines.findIndex((line) => line.trim() === '# Graphify semantic build backend (optional)');
  if (start < 0) return existing;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] ?? '';
    if (/^#?\s*GRAPHIFY_BACKEND=/.test(line)) break;
    if (!line.startsWith('#')) break;
    end += 1;
  }
  const out = [...lines.slice(0, start), ...GRAPHIFY_LLM_ENV_HEADER, ...lines.slice(end)];
  return out.join('\n');
}
