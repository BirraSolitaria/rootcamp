import { createDb } from '@rootcamp/db';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { harnessAppDeps, useHarness } from './harness.js';

const h = useHarness();

describe('GET /api/health', () => {
  it('returns 200 {db:true, smtpLastOkAt:null} when the database answers', async () => {
    const res = await h().app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ db: true, smtpLastOkAt: null });
  });

  it('returns 503 {db:false} when the database is unreachable', async () => {
    // Nothing listens on port 1: the connection is refused immediately.
    const dead = createDb('postgres://u:p@127.0.0.1:1/x', { max: 1 });
    const deps = harnessAppDeps({ ...h().deps, db: dead.db });
    const app = await buildApp(deps);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ db: false, smtpLastOkAt: null });
    } finally {
      await app.close();
      await dead.close();
    }
  });
});
