import { z } from 'zod';

/**
 * Optional `ImageRef` fields. The protocol, stream and durable schemas each keep
 * their own `url` rule and spread these, so all three accept the same metadata.
 */
export const imageRefMetadataShape = {
  detail: z.enum(['auto', 'low', 'high']).optional(),
  mediaType: z.string().min(1).max(255).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  byteLength: z.number().int().nonnegative().optional(),
  alt: z.string().max(1000).optional(),
};
