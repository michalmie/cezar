import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/** MSP command ids must be UUIDv7 (Muse 1.4.13's exported schema and live handshake). */
export function museCommandId(): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const museUsageSchema = z.object({
  inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(),
  cachedTokens: z.number().nonnegative().optional(), cacheReadTokens: z.number().nonnegative().optional(),
  cacheWriteTokens: z.number().nonnegative().optional(), reasoningTokens: z.number().nonnegative().optional(),
});

export const museItemSchema = z.object({
  itemId: z.string(), kind: z.string(), status: z.string(),
  text: z.string().optional(), summary: z.array(z.string()).max(1024).optional(), messagePhase: z.string().optional(),
  tool: z.string().optional(), args: z.string().optional(), visibleOutput: z.string().optional(),
  failureReason: z.string().optional(), exitCode: z.number().optional(),
  commandText: z.string().optional(), fallbackText: z.string().optional(),
});

export const museFrameSchema = z.object({
  method: z.string(), params: z.record(z.string(), z.unknown()),
});

export const museSessionSchema = z.object({
  session: z.object({ sessionId: z.string().min(1), modelId: z.string().nullable().optional() }),
});
