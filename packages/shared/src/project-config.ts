import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { parseWorkflowPolicy, type WorkflowPolicy, workflowPolicySchema } from './workflow-policy.js';

const coodraProjectConfigSchema = z
  .object({
    projectSlug: z.string().min(1),
    workflowPolicy: workflowPolicySchema.optional(),
  })
  .loose();

export interface CoodraProjectConfig {
  readonly root: string;
  readonly projectSlug: string;
  readonly workflowPolicy: WorkflowPolicy;
}

export async function readCoodraProjectConfig(startCwd: string | undefined): Promise<CoodraProjectConfig | null> {
  if (startCwd === undefined || startCwd.length === 0) return null;
  let current = isAbsolute(startCwd) ? startCwd : resolve(startCwd);
  for (;;) {
    const configPath = join(current, '.coodra', 'config.json');
    try {
      const parsed = coodraProjectConfigSchema.safeParse(JSON.parse(await readFile(configPath, 'utf8')));
      if (parsed.success) {
        return {
          root: current,
          projectSlug: parsed.data.projectSlug,
          workflowPolicy: parseWorkflowPolicy(parsed.data.workflowPolicy),
        };
      }
    } catch {
      // Keep walking upward; hooks must fail open when project state is missing.
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
