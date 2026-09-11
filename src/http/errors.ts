import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const errorHandler = (nodeEnv: string): ErrorRequestHandler => (error, req, res, _next) => {
  let apiError: ApiError;
  if (error instanceof ApiError) {
    apiError = error;
  } else if (error instanceof ZodError) {
    apiError = new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed');
  } else if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') {
    apiError = new ApiError(413, 'BODY_TOO_LARGE', 'Request body exceeds the allowed limit');
  } else if (error instanceof SyntaxError && 'body' in error) {
    apiError = new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  } else {
    apiError = new ApiError(500, 'INTERNAL_ERROR', 'An internal error occurred');
  }

  const body: Record<string, unknown> = {
    error: {
      code: apiError.code,
      message: apiError.message,
      requestId: req.requestId,
    },
  };
  if (nodeEnv !== 'production' && error instanceof Error && apiError.code === 'INTERNAL_ERROR') {
    body.debug = { name: error.name };
  }
  res.status(apiError.status).json(body);
};
