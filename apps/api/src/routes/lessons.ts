import { AnswerBody } from '@rootcamp/api-contract';
import type { Db } from '@rootcamp/db';
import type { FastifyInstance } from 'fastify';
import type { ContentHolder } from '../services/contentStore.js';
import { abandonSession, answerInSession, startLessonSession } from '../services/lessons.js';

/** Lesson sessions (spec §5.1); content routes answer 503 while no version is active. */
export async function lessonRoutes(
  app: FastifyInstance,
  deps: { db: Db; now: () => number; content: ContentHolder },
) {
  const { db, now, content } = deps;

  app.post<{ Params: { lessonId: string } }>('/api/lessons/:lessonId/start', async (req) =>
    startLessonSession(db, content.current(), req.user!, req.params.lessonId, now()),
  );

  app.post<{ Params: { id: string } }>('/api/sessions/:id/answer', async (req) => {
    const body = AnswerBody.parse(req.body);
    return answerInSession(db, content.current(), req.user!, req.params.id, body, now());
  });

  app.post<{ Params: { id: string } }>('/api/sessions/:id/abandon', async (req, reply) => {
    await abandonSession(db, req.user!, req.params.id, now());
    return reply.code(204).send();
  });
}
