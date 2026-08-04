import { z } from 'zod';

export const workPackStatusInputSchema = z
  .object({
    runId: z.string().min(1).max(256).optional().describe('Optional run id to scope results to the current project.'),
    // BM25 full-text search (2026-08-03) — matches search_packs_nl/
    // query_decisions' query semantics against work_packs_fts/search_vector
    // (title + spec/implementation/sync markdown). Every word must appear;
    // results order by relevance instead of updatedAt when set.
    query: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Optional BM25-ranked keyword search against title + spec/implementation/sync markdown. Best match first.',
      ),
  })
  .strict()
  .describe('Input for coodra__work_pack_status.');

const rowSchema = z
  .object({
    id: z.string().min(1),
    slug: z.string().min(1),
    title: z.string(),
    packType: z.string(),
    status: z.string(),
    updatedAt: z.date(),
    externalKey: z.string().nullable(),
    externalStatus: z.string().nullable(),
    syncState: z.string().nullable(),
  })
  .strict();

const successBranch = z.object({ ok: z.literal(true), projectId: z.string().nullable(), packs: z.array(rowSchema) });
const runNotFoundBranch = z.object({
  ok: z.literal(false),
  error: z.literal('run_not_found'),
  howToFix: z.string().min(1),
});

export const workPackStatusOutputSchema = z.discriminatedUnion('ok', [successBranch, runNotFoundBranch]);

export type WorkPackStatusInput = z.infer<typeof workPackStatusInputSchema>;
export type WorkPackStatusOutput = z.infer<typeof workPackStatusOutputSchema>;
