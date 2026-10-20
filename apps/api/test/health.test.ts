import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

function appWithPing(result: boolean) {
  return buildApp({ db: { ping: async () => result } });
}

describe('GET /api/health', () => {
  it('returns 200 {db:true} when the database answers', async () => {
    const app = appWithPing(true);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ db: true });
    await app.close();
  });

  it('returns 503 {db:false} when the database is unreachable', async () => {
    const app = appWithPing(false);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ db: false });
    await app.close();
  });
});
