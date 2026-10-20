import Fastify, { type FastifyInstance } from 'fastify';

export interface AppDeps {
  db: { ping(): Promise<boolean> };
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/api/health', async (_req, reply) => {
    const db = await deps.db.ping();
    return reply.code(db ? 200 : 503).send({ db });
  });

  return app;
}
