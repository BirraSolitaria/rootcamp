import type { ApiError, ErrorCode } from '@rootcamp/api-contract';
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';

/** Thrown by services and hooks; the `errors` plugin turns it into an `ApiError` response. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly extra: object | undefined;
  /** Response headers sent with the error (e.g. `retry-after`). */
  readonly headers: Record<string, string> = {};

  constructor(status: number, code: ErrorCode, message?: string, extra?: object) {
    super(message ?? code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** `429 rate_limited` with `Retry-After` in whole seconds (at least 1). */
export function rateLimited(
  retryAfterMs: number,
  message = 'too many requests, try again later',
): HttpError {
  const err = new HttpError(429, 'rate_limited', message);
  err.headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  return err;
}

/** Fastify's own 4xx errors (body parsing, content type, size) mapped onto contract codes. */
const FRAMEWORK_CODES: Record<number, ErrorCode> = {
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  429: 'rate_limited',
};

export function sendError(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
  extra?: object,
) {
  const body: ApiError = { error: { ...extra, code, message } };
  return reply.code(status).send(body);
}

function zodMessage(err: z.ZodError): string {
  return err.issues
    .map((i) => (i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

export default fp(
  async function errors(app: FastifyInstance) {
    app.setErrorHandler((err: FastifyError | Error, req, reply) => {
      if (err instanceof HttpError) {
        reply.headers(err.headers);
        return sendError(reply, err.status, err.code, err.message, err.extra);
      }
      if (err instanceof z.ZodError) {
        return sendError(reply, 400, 'validation', zodMessage(err));
      }
      const status = (err as FastifyError).statusCode;
      if (status !== undefined && status >= 400 && status < 500) {
        return sendError(reply, status, FRAMEWORK_CODES[status] ?? 'validation', err.message);
      }
      req.log.error({ err }, 'unhandled error');
      return sendError(reply, 500, 'internal', `internal error (reqId ${req.id})`);
    });

    app.setNotFoundHandler((req, reply) =>
      sendError(reply, 404, 'not_found', `route ${req.method} ${req.url} not found`),
    );

    // Lets users quote the id from "Что-то сломалось (код reqId)" and admins find the log line.
    app.addHook('onSend', async (req, reply) => {
      reply.header('x-request-id', req.id);
    });
  },
  { name: 'rc-errors' },
);
