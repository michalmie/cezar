import { z } from 'zod';

export const featurePreviewParamsSchema = z.object({ id: z.string().uuid() });
export const featurePreviewResponseSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false), reason: z.string() }),
  z.object({
    available: z.literal(true),
    factoryUrl: z.string().url(),
    taskId: z.string().uuid(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    number: z.number().int().positive(),
  }),
]);
export type FeaturePreviewResponse = z.infer<typeof featurePreviewResponseSchema>;
