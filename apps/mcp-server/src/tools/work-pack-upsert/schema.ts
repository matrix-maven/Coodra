import { z } from 'zod';

const slugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be kebab-case');

const sourceSchema = z
  .object({
    provider: z.string().min(1).default('atlassian'),
    externalKey: z.string().min(1).max(80),
    issueType: z.string().min(1).max(80),
    status: z.string().min(1).max(120),
    url: z.string().url().optional(),
    parentExternalKey: z.string().min(1).max(80).optional(),
    rawExternalJson: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const relationshipSchema = z
  .object({
    targetExternalKey: z.string().min(1).max(80),
    relationshipType: z.string().min(1).max(80),
    syncLevel: z.enum(['summary', 'full']).optional(),
    metadataJson: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const workPackUpsertInputSchema = z
  .object({
    runId: z.string().min(1).max(256).describe('The run id returned by get_run_id for the current project session.'),
    slug: slugSchema.describe('Repo-local Work Pack slug, normally the lowercased Jira key such as cood-12.'),
    title: z.string().min(1).max(300),
    packType: z
      .string()
      .min(1)
      .max(80)
      .describe('External work type: epic, feature, story, task, bug, subtask, spike, or unknown.'),
    status: z.string().min(1).max(120).default('draft'),
    source: sourceSchema.describe('The Jira/Atlassian issue the agent fetched through Atlassian MCP.'),
    specMarkdown: z.string().default(''),
    implementationMarkdown: z.string().default(''),
    syncMarkdown: z.string().default(''),
    metadataJson: z.record(z.string(), z.unknown()).optional(),
    relationships: z.array(relationshipSchema).max(50).optional(),
  })
  .strict()
  .describe('Input for coodra__work_pack_upsert.');

const successBranch = z
  .object({
    ok: z.literal(true),
    projectId: z.string().min(1),
    workPackId: z.string().min(1),
    externalWorkItemId: z.string().min(1),
    slug: z.string().min(1),
    fileDir: z.string().nullable(),
    relationshipCount: z.number().int().nonnegative(),
  })
  .strict();

const runNotFoundBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('run_not_found'),
    howToFix: z.string().min(1),
  })
  .strict();

export const workPackUpsertOutputSchema = z.discriminatedUnion('ok', [successBranch, runNotFoundBranch]);

export type WorkPackUpsertInput = z.infer<typeof workPackUpsertInputSchema>;
export type WorkPackUpsertOutput = z.infer<typeof workPackUpsertOutputSchema>;
