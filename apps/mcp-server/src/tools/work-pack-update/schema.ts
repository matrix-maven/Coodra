import { z } from 'zod';

const slugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be kebab-case');

const relationshipSchema = z
  .object({
    targetExternalKey: z.string().min(1).max(80),
    relationshipType: z.string().min(1).max(80),
    syncLevel: z.enum(['summary', 'full']).optional(),
    metadataJson: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const patchSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    packType: z.string().min(1).max(80).optional(),
    status: z.string().min(1).max(120).optional(),
    specMarkdown: z.string().optional(),
    implementationMarkdown: z.string().optional(),
    syncMarkdown: z.string().optional(),
    metadataJson: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const workPackUpdateInputSchema = z
  .object({
    runId: z.string().min(1).max(256).describe('The run id returned by get_run_id for the current project session.'),
    slug: slugSchema.describe(
      'Existing repo-local Work Pack slug, normally the lowercased external key such as cood-12.',
    ),
    patch: patchSchema.describe(
      'Partial local Work Pack edits. Omitted fields are preserved; metadataJson is shallow-merged into existing metadata.',
    ),
    relationships: z
      .array(relationshipSchema)
      .max(50)
      .optional()
      .describe('Optional full replacement for the local relationship map. Omit to preserve existing relationships.'),
    changeReason: z
      .string()
      .min(1)
      .max(1000)
      .optional()
      .describe('Short reason for the local revision, used in sync_events and later Jira sync-back summaries.'),
  })
  .strict()
  .refine(
    (input) => Object.keys(input.patch).length > 0 || input.relationships !== undefined,
    'Provide at least one patch field or relationships replacement.',
  )
  .describe('Input for coodra__work_pack_update.');

const successBranch = z
  .object({
    ok: z.literal(true),
    projectId: z.string().min(1),
    workPackId: z.string().min(1),
    slug: z.string().min(1),
    fieldsChanged: z.array(z.string().min(1)),
    syncState: z.enum(['local_ahead', 'local_only']),
    externalLinkCount: z.number().int().nonnegative(),
    relationshipCount: z.number().int().nonnegative(),
    fileDir: z.string().nullable(),
  })
  .strict();

const runNotFoundBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('run_not_found'),
    howToFix: z.string().min(1),
  })
  .strict();

const workPackNotFoundBranch = z
  .object({
    ok: z.literal(false),
    error: z.literal('work_pack_not_found'),
    howToFix: z.string().min(1),
  })
  .strict();

export const workPackUpdateOutputSchema = z.union([successBranch, runNotFoundBranch, workPackNotFoundBranch]);

export type WorkPackUpdateInput = z.infer<typeof workPackUpdateInputSchema>;
export type WorkPackUpdateOutput = z.infer<typeof workPackUpdateOutputSchema>;
