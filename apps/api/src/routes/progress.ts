import type { Db } from '@rootcamp/db';
import type { FastifyInstance } from 'fastify';
import type { ContentHolder } from '../services/contentStore.js';
import { getProgress } from '../services/progress.js';

/** `GET /api/progress`; 503 while no content version is active. */
export async function progressRoutes(
  app: FastifyInstance,
  deps: { db: Db; now: () => number; content: ContentHolder },
) {
  app.get('/api/progress', async (req) =>
    getProgress(deps.db, deps.content.current(), req.user!.id, deps.now()),
  );
}
