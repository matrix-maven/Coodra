export type PolicyEvaluatorKey = 'tool_call' | 'bash_command' | 'file_protection' | 'config_drift' | 'completion_gate';

export type PolicyEventName =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'
  | 'SubagentStop'
  | 'ConfigChange'
  | 'SessionStart'
  | 'SessionEnd';

export type PolicyRuleDecision = 'allow' | 'ask' | 'deny' | 'record' | 'flag' | 'block' | 'warn' | 'pass';

export interface PolicyEvaluatorDefinition {
  readonly key: PolicyEvaluatorKey;
  readonly label: string;
  readonly description: string;
  readonly events: readonly PolicyEventName[];
  readonly decisions: readonly PolicyRuleDecision[];
  readonly requiresTool: boolean;
  readonly requiresPath: boolean;
  readonly requiresCommand: boolean;
  readonly syncMode: 'sync' | 'async';
  readonly failPosture: 'fail_open' | 'fail_closed';
  readonly examples: readonly string[];
}

export const POLICY_EVALUATORS: readonly PolicyEvaluatorDefinition[] = [
  {
    key: 'tool_call',
    label: 'Tool Call Firewall',
    description: 'Match an agent tool by name, optionally scoped to path. Best for MCP tools and generic actions.',
    events: ['PreToolUse', 'PostToolUse'],
    decisions: ['allow', 'ask', 'deny'],
    requiresTool: true,
    requiresPath: false,
    requiresCommand: false,
    syncMode: 'sync',
    failPosture: 'fail_open',
    examples: ['mcp__github__*', 'Write + **/.env'],
  },
  {
    key: 'bash_command',
    label: 'Bash Command',
    description:
      'Match the shell command text. Use this for force pushes, destructive commands, redirects, and install pipelines.',
    events: ['PreToolUse', 'PostToolUse'],
    decisions: ['allow', 'ask', 'deny'],
    requiresTool: false,
    requiresPath: false,
    requiresCommand: true,
    syncMode: 'sync',
    failPosture: 'fail_open',
    examples: ['git push *--force*', 'rm -rf*', '* > .env*', 'curl*|*bash*'],
  },
  {
    key: 'file_protection',
    label: 'Protected Files',
    description:
      'Protect files or folders such as secrets, Git metadata, generated dependencies, and agent control files.',
    events: ['PreToolUse'],
    decisions: ['allow', 'ask', 'deny'],
    requiresTool: true,
    requiresPath: true,
    requiresCommand: false,
    syncMode: 'sync',
    failPosture: 'fail_closed',
    examples: ['Read + **/.env', 'Edit + .codex/**'],
  },
  {
    key: 'config_drift',
    label: 'Config Drift',
    description: 'React when agent configuration changes. Useful for recording or blocking policy projection drift.',
    events: ['ConfigChange'],
    decisions: ['record', 'flag', 'block'],
    requiresTool: false,
    requiresPath: false,
    requiresCommand: false,
    syncMode: 'sync',
    failPosture: 'fail_open',
    examples: ['flag when policy projection changes'],
  },
  {
    key: 'completion_gate',
    label: 'Completion Gate',
    description:
      'Check local completion obligations before an agent stops, such as branch, decision log, or work-pack update.',
    events: ['Stop', 'SubagentStop'],
    decisions: ['pass', 'warn', 'block'],
    requiresTool: false,
    requiresPath: false,
    requiresCommand: false,
    syncMode: 'sync',
    failPosture: 'fail_open',
    examples: ['block completion until tests run', 'warn if no Work Pack update exists'],
  },
];

export function getPolicyEvaluator(key: string | null | undefined): PolicyEvaluatorDefinition {
  const fallback = POLICY_EVALUATORS[0];
  if (fallback === undefined) throw new Error('POLICY_EVALUATORS must contain at least one evaluator');
  return POLICY_EVALUATORS.find((evaluator) => evaluator.key === key) ?? fallback;
}

export function policyDecisionForStorage(decision: string): 'allow' | 'ask' | 'deny' {
  if (decision === 'deny' || decision === 'block') return 'deny';
  if (decision === 'ask' || decision === 'warn' || decision === 'flag') return 'ask';
  return 'allow';
}
