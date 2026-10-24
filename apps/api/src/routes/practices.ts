import type { Db } from '@rootcamp/db';
import type { FastifyInstance } from 'fastify';
import type { ContentHolder } from '../services/contentStore.js';
import { listPractices } from '../services/practices.js';
import type { RunService } from '../services/runs.js';

/**
 * Practice routes (spec §5.1 «Практика»). Without sandboxd (`SANDBOXD_URL` unset) the run
 * routes answer `503 queue_full`; the listing works from content and the DB alone.
 */
export async function practiceRoutes(
  app: FastifyInstance,
  deps: { db: Db; content: ContentHolder; runs: RunService },
) {
  const { db, content, runs } = deps;
  type RunParams = { Params: { runId: string } };

  app.get('/api/practices', async (req) => listPractices(db, content.current(), req.user!.id));

  app.post<{ Params: { id: string } }>('/api/practices/:id/runs', async (req, reply) =>
    reply.code(201).send(await runs.createRun(req.user!, req.params.id)),
  );

  app.get<RunParams>('/api/runs/:runId', async (req) => runs.getRun(req.user!, req.params.runId));

  app.post<RunParams>('/api/runs/:runId/terminal-ticket', async (req) =>
    runs.terminalTicket(req.user!, req.params.runId),
  );

  app.post<RunParams>('/api/runs/:runId/check', async (req) =>
    runs.check(req.user!, req.params.runId),
  );

  app.post<RunParams>('/api/runs/:runId/hints', async (req) =>
    runs.revealHint(req.user!, req.params.runId),
  );

  app.post<RunParams>('/api/runs/:runId/extend', async (req) =>
    runs.extend(req.user!, req.params.runId),
  );

  app.post<RunParams>('/api/runs/:runId/reset', async (req) =>
    runs.reset(req.user!, req.params.runId),
  );

  app.post<RunParams>('/api/runs/:runId/stop', async (req, reply) => {
    await runs.stop(req.user!, req.params.runId);
    return reply.code(204).send();
  });
}
