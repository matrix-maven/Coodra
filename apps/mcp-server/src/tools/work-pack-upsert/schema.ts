import { z } from 'zod';

const slugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be kebab-case');

const sourceSchema = z
  .object({
    provider: z
      .string()
      .min(1)
      .default('atlassian')
      .describe('Origin system: atlassian, github, gitlab, manual, or any future provider — free string, not an enum.'),
    externalKey: z.string().min(1).max(80),
    issueType: z
      .string()
      .min(1)
      .max(80)
      .describe(
        "The provider's own native type label, preserved as-is — e.g. Jira 'Story', GitHub 'pull_request', GitLab 'merge_request'. Distinct from packType, which is Coodra's own normalized classification.",
      ),
    status: z
      .string()
      .min(1)
      .max(120)
      .describe(
        "The provider's own native status label, preserved as-is — e.g. Jira 'In Review', a GitHub PR's open/merged/closed. Distinct from the top-level status, which is Coodra's own normalized lifecycle state.",
      ),
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
    slug: slugSchema.describe('Repo-local Work Pack slug, normally the lowercased external key such as cood-12.'),
    title: z.string().min(1).max(300),
    packType: z
      .string()
      .min(1)
      .max(80)
      .describe(
        "Coodra's canonical Work Pack type: epic, feature, story, task, bug, subtask, spike, pr, or unknown. Normalize the provider's native type into this fixed set — the provider's own raw label goes in source.issueType instead.",
      ),
    status: z
      .string()
      .min(1)
      .max(120)
      .default('draft')
      .describe(
        "Coodra's own canonical Work Pack status: draft, in_progress, in_review, blocked, or done (default 'draft'). Normalize the provider's native status into this small set — the provider's own raw status label goes in source.status instead.",
      ),
    source: sourceSchema.describe(
      'The external item (Jira issue, GitHub/GitLab PR, or manual entry) the agent fetched through its own provider MCP — or synthesized for a manually-created pack.',
    ),
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
