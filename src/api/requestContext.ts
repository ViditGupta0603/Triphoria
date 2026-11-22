import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { logger } from '../logger';

const ID_PATTERN = /^[\w.-]{1,128}$/;

export const requestContext: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  const requestId = incoming && ID_PATTERN.test(incoming) ? incoming : randomUUID();
  const log = logger.child({ requestId });

  res.locals.requestId = requestId;
  res.locals.log = log;
  res.setHeader('X-Request-Id', requestId);

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    log.info(
      { method: req.method, url: req.originalUrl, status: res.statusCode, durationMs: Math.round(durationMs) },
      'Request completed',
    );
  });

  next();
};
