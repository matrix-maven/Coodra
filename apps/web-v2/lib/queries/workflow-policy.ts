import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectListRow } from '@coodra/db';
import { defaultWorkflowPolicy, parseWorkflowPolicy, type WorkflowPolicy } from '@coodra/shared/workflow-policy';

interface RawProjectConfig {
  readonly mode?: unknown;
  readonly workflowPolicy?: unknown;
}

export interface WorkflowPolicyView {
  readonly projectId: string;
  readonly projectSlug: string;
  readonly cwd: string | null;
  readonly configPath: string | null;
  readonly exists: boolean;
  readonly policy: WorkflowPolicy;
  readonly error: string | null;
}

export async function listWorkflowPolicies(projects: ReadonlyArray<ProjectListRow>): Promise<WorkflowPolicyView[]> {
  return Promise.all(projects.map(readWorkflowPolicy));
}

export async function readWorkflowPolicy(project: ProjectListRow): Promise<WorkflowPolicyView> {
  if (project.cwd === null || project.cwd.length === 0) {
    return {
      projectId: project.id,
      projectSlug: project.slug,
      cwd: project.cwd,
      configPath: null,
      exists: false,
      policy: defaultWorkflowPolicy('solo'),
      error: 'project cwd is unknown',
    };
  }

  const configPath = join(project.cwd, '.coodra', 'config.json');
  try {
    const raw = JSON.parse(await readFile(configPath, 'utf8')) as RawProjectConfig;
    const mode = raw.mode === 'team' ? 'team' : 'solo';
    return {
      projectId: project.id,
      projectSlug: project.slug,
      cwd: project.cwd,
      configPath,
      exists: true,
      policy: parseWorkflowPolicy(raw.workflowPolicy, mode),
      error: null,
    };
  } catch (err) {
    return {
      projectId: project.id,
      projectSlug: project.slug,
      cwd: project.cwd,
      configPath,
      exists: false,
      policy: defaultWorkflowPolicy('solo'),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
