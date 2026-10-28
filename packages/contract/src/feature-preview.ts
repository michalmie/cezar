import { z } from 'zod';

export const featurePreviewParamsSchema = z.object({ id: z.string().uuid() });
export const featurePreviewResponseSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false), reason: z.string() }),
  z.object({
    available: z.literal(true),
    mode: z.enum(['claim', 'manual']),
    factoryUrl: z.string().url(),
    taskId: z.string().uuid(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    number: z.number().int().positive().optional(),
    branch: z.string().min(1).optional(),
    title: z.string().optional(),
  }),
]);
export type FeaturePreviewResponse = z.infer<typeof featurePreviewResponseSchema>;
