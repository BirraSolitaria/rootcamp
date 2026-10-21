import { StartReviewBody } from '@rootcamp/api-contract';
import type { Db } from '@rootcamp/db';
import type { FastifyInstance } from 'fastify';
import type { ContentHolder } from '../services/contentStore.js';
import { startReview } from '../services/review.js';

/** Review and drill sessions (spec §5.1); answers go to `POST /api/sessions/:id/answer`. */
export async function reviewRoutes(
  app: FastifyInstance,
  deps: { db: Db; now: () => number; content: ContentHolder },
) {
  const { db, now, content } = deps;

  app.post('/api/review/start', async (req, reply) => {
    const { mode } = StartReviewBody.parse(req.body);
    const started = await startReview(db, content.current(), req.user!, mode, now());
    if (!started) return reply.code(204).send();
    return started;
  });
}
