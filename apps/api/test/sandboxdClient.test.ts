// Pure tests (no Docker): the sandboxd HTTP client against a stub `fetch`, the fake's contract and
// the SandboxView → practice_runs.status mapping.
import { describe, expect, it } from 'vitest';
import { runStatusOf } from '../src/services/runs.js';
import {
  createFakeSandboxdClient,
  createHttpSandboxdClient,
  SandboxdError,
} from '../src/services/sandboxdClient.js';

const SID = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

const view = {
  sandboxId: SID,
  state: 'queued',
  stopReason: null,
  queuePosition: 1,
  expiresAt: null,
  hardDeadline: null,
  readyAt: null,
  canExtend: false,
  usage: null,
};

const body = {
  runId: RUN,
  userId: USER,
  image: 'rc/test-shell',
  class: 'light' as const,
  hostname: 'web-01',
  title: 't',
  setupScript: 'true',
  setupTimeoutSec: 60,
  ttlMin: 20,
};

interface Seen {
  url: string;
  init: RequestInit;
}

function stub(status: number, answer: unknown, seen: Seen[] = []): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    const text = answer === undefined ? '' : JSON.stringify(answer);
    return new Response(status === 204 ? null : text, { status });
  }) as typeof fetch;
}

describe('createHttpSandboxdClient', () => {
  it('sends the bearer token and JSON body, parses SandboxView', async () => {
    const seen: Seen[] = [];
    const c = createHttpSandboxdClient('http://sbx:3001/', 'tok', { fetch: stub(201, view, seen) });
    expect(await c.create(body)).toEqual(view);
    expect(seen[0]!.url).toBe('http://sbx:3001/internal/sandboxes');
    expect(seen[0]!.init.method).toBe('POST');
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual(body);
  });

  it('get passes ?passive=1 only when asked', async () => {
    const seen: Seen[] = [];
    const c = createHttpSandboxdClient('http://sbx:3001', 'tok', { fetch: stub(200, view, seen) });
    await c.get(SID);
    await c.get(SID, { passive: true });
    expect(seen.map((s) => s.url)).toEqual([
      `http://sbx:3001/internal/sandboxes/${SID}`,
      `http://sbx:3001/internal/sandboxes/${SID}?passive=1`,
    ]);
  });

  it('remove sends DELETE {reason} and accepts 204', async () => {
    const seen: Seen[] = [];
    const c = createHttpSandboxdClient('http://sbx', 'tok', { fetch: stub(204, undefined, seen) });
    await c.remove(SID, 'solved');
    expect(seen[0]!.init.method).toBe('DELETE');
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ reason: 'solved' });
  });

  it("maps sandboxd's error answer to SandboxdError(status, code)", async () => {
    const c = createHttpSandboxdClient('http://sbx', 'tok', {
      fetch: stub(409, { error: { code: 'queue_full', message: 'full' } }),
    });
    await expect(c.create(body)).rejects.toMatchObject({
      name: 'SandboxdError',
      status: 409,
      code: 'queue_full',
      message: 'full',
    });
  });

  it('no answer or a malformed one → SandboxdError(503, unavailable); health → false', async () => {
    const refused = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const c = createHttpSandboxdClient('http://sbx', 'tok', { fetch: refused });
    await expect(c.get(SID)).rejects.toMatchObject({ status: 503, code: 'unavailable' });
    expect(await c.health()).toBe(false);
    const bad = createHttpSandboxdClient('http://sbx', 'tok', { fetch: stub(200, { nope: 1 }) });
    await expect(bad.get(SID)).rejects.toBeInstanceOf(SandboxdError);
    const ok = createHttpSandboxdClient('http://sbx', 'tok', { fetch: stub(200, { ok: true }) });
    expect(await ok.health()).toBe(true);
  });
});

describe('createFakeSandboxdClient', () => {
  it('one active sandbox per user, scripted exit codes, idempotent remove', async () => {
    const fake = createFakeSandboxdClient(() => 0);
    const v = await fake.create(body);
    await expect(fake.create({ ...body, runId: SID })).rejects.toMatchObject({
      code: 'run_exists',
    });
    await expect(
      fake.execChecks(v.sandboxId, { checks: [{ goalId: 'a', script: '', timeoutSec: 1 }] }),
    ).rejects.toMatchObject({ code: 'validation' });
    fake.setState(v.sandboxId, 'ready');
    fake.setGoalExitCodes([0, 2]);
    const results = await fake.execChecks(v.sandboxId, {
      checks: [
        { goalId: 'a', script: '', timeoutSec: 1 },
        { goalId: 'b', script: '', timeoutSec: 1 },
      ],
    });
    expect(results.map((r) => r.exitCode)).toEqual([0, 2]);
    await fake.remove(v.sandboxId, 'stopped_by_user');
    await fake.remove(v.sandboxId, 'idle');
    expect(fake.sandboxes.get(v.sandboxId)!.removedWith).toBe('stopped_by_user');
    expect((await fake.get(v.sandboxId)).state).toBe('stopped');
    await fake.create({ ...body, runId: SID });
  });
});

describe('runStatusOf', () => {
  it.each([
    ['queued', null, 'queued'],
    ['starting', null, 'starting'],
    ['ready', null, 'ready'],
    ['stopped', 'expired', 'expired'],
    ['stopped', 'solved', 'solved'],
    ['stopped', 'queue_timeout', 'queue_timeout'],
    ['stopped', 'stopped_by_user', 'stopped'],
    ['stopped', 'idle', 'stopped'],
    ['stopping', 'expired', 'expired'],
    ['failed', 'oom', 'failed'],
  ] as const)('%s + %s → %s', (state, stopReason, expected) => {
    expect(runStatusOf({ state, stopReason })).toBe(expected);
  });
});
