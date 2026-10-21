import type { ContentVersionDto } from '@rootcamp/api-contract';
import type { FastifyInstance } from 'fastify';
import type { ContentHolder } from '../services/contentStore.js';

/** `GET /api/content/version` → `{version, baseUrl}`; 503 while no version is active. */
export async function contentRoutes(app: FastifyInstance, deps: { content: ContentHolder }) {
  app.get('/api/content/version', async (): Promise<ContentVersionDto> => {
    const { version } = deps.content.current();
    return { version, baseUrl: `/content/${version}/` };
  });
}
