import type { ErrorRequestHandler, RequestHandler } from 'express';
import { logger } from '../logger';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 400 — bad client input. */
export class ValidationError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, message, details);
  }
}

/** 502 — upstream suppliers failed. */
export class UpstreamError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(502, message, details);
  }
}

/** 503 — one of our own dependencies (Redis, Temporal) is unavailable. */
export class DependencyError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(503, message, details);
  }
}

export const notFound: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, `Route ${req.method} ${req.path} not found`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const log = (res.locals.log as typeof logger | undefined) ?? logger;

  // Malformed JSON body from express.json()
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Malformed JSON body' });
    return;
  }

  if (err instanceof HttpError) {
    const level = err.status >= 500 ? 'error' : 'warn';
    log[level]({ status: err.status, err: err.message, details: err.details, path: req.path }, 'Request failed');
    res.status(err.status).json(err.details === undefined ? { error: err.message } : { error: err.message, details: err.details });
    return;
  }

  log.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
};
