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

  const lines = existing.trimEnd().length > 0 ? [existing.trimEnd(), ''] : [];
  if (!/^# Graphify semantic build backend/m.test(existing)) {
    lines.push('# Graphify semantic build backend (optional)');
    lines.push('# Uncomment one backend/key pair for semantic `coodra graphify build`.');
    lines.push('# Without these, use `coodra graphify build --no-llm` for a structural graph.');
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
