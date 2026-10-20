import { describe, expect, test } from 'vitest';
import { loadConfig, parsePort } from '../src/config.js';

test('parsePort defaults to 3000 when PORT is unset or empty', () => {
  expect(parsePort(undefined)).toBe(3000);
  expect(parsePort('')).toBe(3000);
});

test('parsePort accepts a decimal TCP port', () => {
  expect(parsePort('8080')).toBe(8080);
  expect(parsePort(' 3001 ')).toBe(3001);
  expect(parsePort('0')).toBe(0);
  expect(parsePort('65535')).toBe(65535);
});

test.each(['abc', '30a0', '3000.5', '-1', '65536', '0x10', '1e3', 'NaN'])(
  'parsePort rejects %j with a clear error',
  (value) => {
    expect(() => parsePort(value)).toThrow(`PORT must be an integer 0-65535, got "${value}"`);
  },
);

const env = {
  DATABASE_URL: 'postgres://rootcamp:pw@postgres:5432/rootcamp',
  PUBLIC_ORIGIN: 'https://rootcamp.example',
  SMTP_HOST: 'smtp.example',
  SMTP_USER: 'mailer',
  SMTP_PASS: 'secret',
  SMTP_FROM: 'rootcamp <noreply@rootcamp.example>',
  INTERNAL_TOKEN: 'internal-token-0123456789',
  TICKET_SECRET: 'ticket-secret-0123456789abcdef0123',
  SANDBOXD_URL: 'http://sandboxd:7070',
  CONTENT_DIR: '/content',
  NODE_ENV: 'production',
};

describe('loadConfig', () => {
  test('parses a complete environment and applies defaults', () => {
    const c = loadConfig(env);
    expect(c).toMatchObject({
      DATABASE_URL: env.DATABASE_URL,
      PUBLIC_ORIGIN: 'https://rootcamp.example',
      COOKIE_SECURE: true,
      SMTP_HOST: 'smtp.example',
      SMTP_PORT: 587,
      SMTP_USER: 'mailer',
      SMTP_PASS: 'secret',
      SMTP_FROM: env.SMTP_FROM,
      INTERNAL_TOKEN: env.INTERNAL_TOKEN,
      TICKET_SECRET: env.TICKET_SECRET,
      SANDBOXD_URL: env.SANDBOXD_URL,
      CONTENT_DIR: '/content',
      NODE_ENV: 'production',
      PORT: 3000,
      HOST: '0.0.0.0',
    });
  });

  test('COOKIE_SECURE accepts only true/false; SMTP_PORT and PORT parse as numbers', () => {
    expect(loadConfig({ ...env, COOKIE_SECURE: 'false' }).COOKIE_SECURE).toBe(false);
    expect(loadConfig({ ...env, COOKIE_SECURE: 'true' }).COOKIE_SECURE).toBe(true);
    expect(() => loadConfig({ ...env, COOKIE_SECURE: 'no' })).toThrow(/COOKIE_SECURE/);
    expect(loadConfig({ ...env, SMTP_PORT: '1025' }).SMTP_PORT).toBe(1025);
    expect(() => loadConfig({ ...env, SMTP_PORT: 'abc' })).toThrow(/SMTP_PORT/);
    expect(loadConfig({ ...env, PORT: '8081' }).PORT).toBe(8081);
    expect(() => loadConfig({ ...env, PORT: 'NaN' })).toThrow(/PORT/);
  });

  test('PUBLIC_ORIGIN is normalised to a bare origin; paths are rejected', () => {
    expect(loadConfig({ ...env, PUBLIC_ORIGIN: 'http://127.0.0.1:8080/' }).PUBLIC_ORIGIN).toBe(
      'http://127.0.0.1:8080',
    );
    expect(() => loadConfig({ ...env, PUBLIC_ORIGIN: 'https://a.example/app' })).toThrow(
      /PUBLIC_ORIGIN/,
    );
  });

  test('missing required variables are all named in one error', () => {
    const partial: Record<string, string | undefined> = { ...env };
    delete partial.DATABASE_URL;
    delete partial.TICKET_SECRET;
    expect(() => loadConfig(partial)).toThrow(/DATABASE_URL[\s\S]*TICKET_SECRET/);
  });

  test('empty SMTP credentials are allowed (local relays such as Mailpit need none)', () => {
    const c = loadConfig({ ...env, SMTP_USER: '', SMTP_PASS: undefined });
    expect(c.SMTP_USER).toBeUndefined();
    expect(c.SMTP_PASS).toBeUndefined();
  });

  test('secrets must be at least 16 characters', () => {
    expect(() => loadConfig({ ...env, INTERNAL_TOKEN: 'short' })).toThrow(/INTERNAL_TOKEN/);
  });
});

describe('TRUST_PROXY_HOPS', () => {
  test('defaults to 1 (Caddy in front); accepts 0..9', () => {
    expect(loadConfig(env).TRUST_PROXY_HOPS).toBe(1);
    expect(loadConfig({ ...env, TRUST_PROXY_HOPS: '' }).TRUST_PROXY_HOPS).toBe(1);
    expect(loadConfig({ ...env, TRUST_PROXY_HOPS: '0' }).TRUST_PROXY_HOPS).toBe(0);
    expect(loadConfig({ ...env, TRUST_PROXY_HOPS: '2' }).TRUST_PROXY_HOPS).toBe(2);
  });

  test.each(['-1', 'true', '1.5', '10'])('rejects %j', (value) => {
    expect(() => loadConfig({ ...env, TRUST_PROXY_HOPS: value })).toThrow(/TRUST_PROXY_HOPS/);
  });
});
