/**
 * Single source of truth: v2 design document §6.5 (error handling)
 */
import { z } from 'zod';

export const ErrorLevel = {
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
  FATAL: 'FATAL',
} as const;
export type ErrorLevel = (typeof ErrorLevel)[keyof typeof ErrorLevel];

export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  EXTERNAL_SERVICE_ERROR: 'EXTERNAL_SERVICE_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
} as const;
export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ApiErrorSchema = z.object({
  code: z.enum([
    'BAD_REQUEST',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'NOT_FOUND',
    'CONFLICT',
    'VALIDATION_ERROR',
    'INTERNAL_ERROR',
    'EXTERNAL_SERVICE_ERROR',
    'DATABASE_ERROR',
    'RATE_LIMITED',
  ]),
  level: z.enum(['INFO', 'WARN', 'ERROR', 'FATAL']).optional(),
  message: z.string(),
  details: z.unknown().optional(),
  request_id: z.string().optional(),
  timestamp: z.string(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
