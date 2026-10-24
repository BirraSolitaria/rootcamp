import { timingSafeEqual } from 'node:crypto';
import {
  CreateSandboxBody,
  DeleteSandboxBody,
  ExecChecksBody,
  type ErrorCode,
  type ExtendSandboxResponse,
  type MetricsDto,
} from '@rootcamp/api-contract';
import type { FastifyError, FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { LifecycleError, type Lifecycle } from '../lifecycle.js';

export interface InternalRoutesOptions {
  lifecycle: Lifecycle;
  /** `GET /internal/metrics`. */
  metrics: { snapshot(): MetricsDto };
  /** `INTERNAL_TOKEN`: every route here requires `Authorization: Bearer <token>`. */
  token: string;
}

const Params = z.object({ id: z.uuid() });
const GetQuery = z.object({ passive: z.enum(['0', '1']).optional() });

const sendError = (reply: FastifyReply, status: number, code: ErrorCode, message: string) =>
  reply.code(status).send({ error: { code, message } });

function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const got = Buffer.from(header.slice('Bearer '.length));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new LifecycleError(
      400,
      'validation',
      r.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; '),
    );
  }
  return r.data;
}

/** A path id that is not a uuid cannot name a sandbox. */
function sandboxId(params: unknown): string {
  const r = Params.safeParse(params);
  if (!r.success) throw new LifecycleError(404, 'not_found', 'no such sandbox');
  return r.data.id;
}

/**
 * Internal REST of sandboxd (spec §5.3), reachable on `rc-internal` only. Any request about a
 * sandbox bumps its `last_activity_at` (throttled to 30 s), except `GET …?passive=1`, meant for
 * background syncs (api's `runs-sync`) that must not keep an idle sandbox alive.
 */
export async function internalRoutes(
  app: FastifyInstance,
  o: InternalRoutesOptions,
): Promise<void> {
  const { lifecycle } = o;

  app.addHook('onRequest', async (req, reply) => {
    if (!bearerMatches(req.headers.authorization, o.token)) {
      return sendError(reply, 401, 'unauthorized', 'missing or wrong internal token');
    }
  });

  app.setErrorHandler((err: FastifyError | LifecycleError, req, reply) => {
    if (err instanceof LifecycleError) {
      return sendError(reply, err.statusCode, err.code, err.message);
    }
    if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      // Fastify's own 4xx (malformed JSON, wrong content type, body too large).
      return sendError(reply, err.statusCode, 'validation', err.message);
    }
    req.log.error({ err }, 'internal route failed');
    return sendError(reply, 500, 'internal', 'internal error');
  });

  app.get('/internal/health', async () => ({ ok: true }));

  app.get('/internal/metrics', async (): Promise<MetricsDto> => o.metrics.snapshot());

  app.post('/internal/sandboxes', async (req, reply) => {
    const body = parse(CreateSandboxBody, req.body);
    const view = await lifecycle.enqueue(body);
    return reply.code(201).send(view);
  });

  app.get('/internal/sandboxes/:id', async (req) => {
    const id = sandboxId(req.params);
    const { passive } = parse(GetQuery, req.query);
    const view = await lifecycle.view(id);
    if (passive !== '1') await lifecycle.touch(id);
    return view;
  });

  app.post('/internal/sandboxes/:id/exec-checks', async (req) => {
    const id = sandboxId(req.params);
    const { checks } = parse(ExecChecksBody, req.body);
    await lifecycle.touch(id);
    return lifecycle.execChecks(id, checks);
  });

  app.post('/internal/sandboxes/:id/extend', async (req): Promise<ExtendSandboxResponse> => {
    const id = sandboxId(req.params);
    await lifecycle.touch(id);
    const expiresAt = await lifecycle.extend(id);
    return { expiresAt: expiresAt.toISOString() };
  });

  app.delete('/internal/sandboxes/:id', async (req, reply) => {
    const id = sandboxId(req.params);
    const { reason } = parse(DeleteSandboxBody, req.body);
    await lifecycle.stopSandbox(id, reason);
    return reply.code(204).send();
  });
}
