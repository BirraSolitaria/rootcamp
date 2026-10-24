import { createDb } from '@rootcamp/db';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createFakeSandboxdClient } from '../src/services/sandboxdClient.js';
import { harnessAppDeps, useHarness } from './harness.js';

const h = useHarness();

describe('GET /api/health', () => {
  it('returns 200 {db:true, sandboxd:false, smtpLastOkAt:null} without SANDBOXD_URL', async () => {
    const res = await h().app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ db: true, sandboxd: false, smtpLastOkAt: null });
  });

  it('reports sandboxd health without letting it decide the status', async () => {
    const sandboxd = createFakeSandboxdClient();
    const app = await buildApp({ ...harnessAppDeps(h().deps), sandboxd });
    try {
      const up = await app.inject({ method: 'GET', url: '/api/health' });
      expect(up.statusCode).toBe(200);
      expect(up.json()).toMatchObject({ db: true, sandboxd: true });
      sandboxd.setHealthy(false);
      const down = await app.inject({ method: 'GET', url: '/api/health' });
      expect(down.statusCode).toBe(200);
      expect(down.json()).toMatchObject({ db: true, sandboxd: false });
    } finally {
      await app.close();
    }
  });

  it('returns 503 {db:false} when the database is unreachable', async () => {
    // Nothing listens on port 1: the connection is refused immediately.
    const dead = createDb('postgres://u:p@127.0.0.1:1/x', { max: 1 });
    const deps = harnessAppDeps({ ...h().deps, db: dead.db });
    const app = await buildApp(deps);
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ db: false, sandboxd: false, smtpLastOkAt: null });
    } finally {
      await app.close();
      await dead.close();
    }
  });
});
