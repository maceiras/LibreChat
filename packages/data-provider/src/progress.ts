import { z } from 'zod';

export const responseStageSchema = z.enum([
  'preparing',
  'searching',
  'coding',
  'executing',
  'responding',
  'files',
]);

const timestamp = z.number().finite().nonnegative();

export const responseProgressSchema = z.object({
  messageId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  startedAt: timestamp,
  updatedAt: timestamp,
  endedAt: timestamp.optional(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled', 'incomplete']),
  steps: z
    .array(
      z.object({ stage: responseStageSchema, startedAt: timestamp, endedAt: timestamp.optional() }),
    )
    .min(1)
    .max(64),
});

export type ResponseStage = z.infer<typeof responseStageSchema>;
export type ResponseProgress = z.infer<typeof responseProgressSchema>;
