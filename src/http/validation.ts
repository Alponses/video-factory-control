import { z } from 'zod';
import { ApiError } from './errors.js';

export const idSchema = z.string().min(1).max(191).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const positiveVersionSchema = z.number().int().positive();
export const isoDateSchema = z.string().datetime({ offset: true });
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(200).optional(),
  status: z.string().trim().max(64).optional(),
  category: z.string().trim().max(191).optional(),
}).strict();

export function parseRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed');
  return parsed.data;
}
