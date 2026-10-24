import { describe, expect, test } from 'vitest';
import { assertDriverAllowed, loadConfig } from '../src/config.js';

const env = {
  DATABASE_URL: 'postgres://rootcamp:pw@postgres:5432/rootcamp',
  INTERNAL_TOKEN: 'internal-token-0123456789',
  TICKET_SECRET: 'ticket-secret-0123456789abcdef0123',
};

describe('loadConfig', () => {
  test('applies the production defaults', () => {
    const c = loadConfig(env);
    expect(c).toEqual({
      databaseUrl: env.DATABASE_URL,
      internalToken: env.INTERNAL_TOKEN,
      ticketSecret: env.TICKET_SECRET,
      driver: 'sysbox',
      network: 'rc-sbx',
      instance: 'default',
      budget: { memMb: 5120, cpu: 3.5, heavySlots: 1 },
      queueMax: 10,
      hostProc: '/host/proc',
      hostRoot: '/host/root',
      nodeEnv: 'production',
      port: 3001,
      host: '0.0.0.0',
    });
  });

  test('SANDBOXD_INSTANCE: a docker-label-safe name, default "default"', () => {
    expect(loadConfig({ ...env, SANDBOXD_INSTANCE: 'rootcamp-e2e' }).instance).toBe('rootcamp-e2e');
    expect(loadConfig({ ...env, SANDBOXD_INSTANCE: '' }).instance).toBe('default');
    expect(() => loadConfig({ ...env, SANDBOXD_INSTANCE: 'Bad Name' })).toThrow(
      /SANDBOXD_INSTANCE/,
    );
  });

  test('runc-dev defaults to the rc-sbx-dev network', () => {
    expect(loadConfig({ ...env, SANDBOX_DRIVER: 'runc-dev' }).network).toBe('rc-sbx-dev');
  });

  test('reads overrides; empty strings mean unset', () => {
    const c = loadConfig({
      ...env,
      SANDBOX_DRIVER: 'runc-dev',
      SANDBOX_NETWORK: 'my-net',
      BUDGET_MEM_MB: '2048',
      BUDGET_CPU: '1.5',
      HEAVY_SLOTS: '0',
      QUEUE_MAX: '',
      HOST_PROC: '/proc',
      NODE_ENV: 'test',
      PORT: '7070',
    });
    expect(c).toMatchObject({
      driver: 'runc-dev',
      network: 'my-net',
      budget: { memMb: 2048, cpu: 1.5, heavySlots: 0 },
      queueMax: 10,
      hostProc: '/proc',
      nodeEnv: 'test',
      port: 7070,
    });
  });

  test('names every invalid variable', () => {
    expect(() =>
      loadConfig({
        INTERNAL_TOKEN: 'short',
        TICKET_SECRET: env.TICKET_SECRET,
        SANDBOX_DRIVER: 'runc',
        BUDGET_CPU: 'lots',
      }),
    ).toThrow(
      /DATABASE_URL: is required[\s\S]*INTERNAL_TOKEN[\s\S]*SANDBOX_DRIVER[\s\S]*BUDGET_CPU/,
    );
  });
});

describe('assertDriverAllowed', () => {
  test('rejects runc-dev in production', () => {
    expect(() => assertDriverAllowed({ driver: 'runc-dev', nodeEnv: 'production' })).toThrow(
      /runc-dev/,
    );
  });

  test('allows runc-dev outside production and sysbox anywhere', () => {
    expect(() => assertDriverAllowed({ driver: 'runc-dev', nodeEnv: 'development' })).not.toThrow();
    expect(() => assertDriverAllowed({ driver: 'runc-dev', nodeEnv: 'test' })).not.toThrow();
    expect(() => assertDriverAllowed({ driver: 'sysbox', nodeEnv: 'production' })).not.toThrow();
  });

  test('NODE_ENV defaults to production, so a bare runc-dev config fails the startup check', () => {
    const c = loadConfig({ ...env, SANDBOX_DRIVER: 'runc-dev' });
    expect(() => assertDriverAllowed(c)).toThrow();
  });
});
