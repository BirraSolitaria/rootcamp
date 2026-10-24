import { MetricsDto } from '@rootcamp/api-contract';
import type { Db } from '@rootcamp/db';
import { describe, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { SandboxDriver } from '../src/driver/types.js';
import {
  HISTORY_POINTS,
  Metrics,
  cpuPctBetween,
  parseMeminfo,
  parseProcStat,
  usageFromDockerStats,
} from '../src/metrics.js';

// Two /proc/stat snapshots. Columns: user nice system idle iowait irq softirq steal guest
// guest_nice. guest is already counted in user, so it must not be added again.
const STAT_A = `cpu  100 0 50 800 50 0 0 0 0 0
cpu0 50 0 25 400 25 0 0 0 0 0
intr 12345
ctxt 999
`;
const STAT_B = `cpu  160 0 70 950 60 0 10 0 30 0
cpu0 80 0 35 475 30 0 5 0 15 0
intr 12400
`;

const MEMINFO = `MemTotal:        8048640 kB
MemFree:          512000 kB
MemAvailable:    4024320 kB
Buffers:          100000 kB
Cached:          2000000 kB
`;

const MIB = 1024 * 1024;
const STATS = {
  cpu_stats: {
    cpu_usage: { total_usage: 2_000_000_000 },
    system_cpu_usage: 20_000_000_000,
    online_cpus: 4,
  },
  precpu_stats: {
    cpu_usage: { total_usage: 1_000_000_000 },
    system_cpu_usage: 10_000_000_000,
  },
  memory_stats: { usage: 300 * MIB, limit: 512 * MIB, stats: { inactive_file: 44 * MIB } },
};

describe('host parsers', () => {
  test('/proc/stat: the aggregate cpu line, guest not double-counted', () => {
    expect(parseProcStat(STAT_A)).toEqual({ total: 1000, idle: 850 });
    expect(parseProcStat(STAT_B)).toEqual({ total: 1250, idle: 1010 });
  });

  test('cpuPct between two snapshots: busy share of the elapsed jiffies', () => {
    expect(cpuPctBetween(parseProcStat(STAT_A), parseProcStat(STAT_B))).toBe(36);
    // No time passed (or a counter reset): 0, never NaN or negative.
    expect(cpuPctBetween(parseProcStat(STAT_A), parseProcStat(STAT_A))).toBe(0);
    expect(cpuPctBetween(parseProcStat(STAT_B), parseProcStat(STAT_A))).toBe(0);
  });

  test('/proc/stat without a cpu line is an error', () => {
    expect(() => parseProcStat('intr 1\n')).toThrow(/cpu/);
  });

  test('/proc/meminfo: used = MemTotal − MemAvailable, MiB', () => {
    expect(parseMeminfo(MEMINFO)).toEqual({ totalMb: 7860, usedMb: 3930 });
    // Old kernels without MemAvailable: free + buffers + cached count as available.
    const old = MEMINFO.replace(/MemAvailable.*\n/, '');
    expect(parseMeminfo(old)).toEqual({ totalMb: 7860, usedMb: 5309.2 });
  });
});

describe('docker stats → usage', () => {
  test('cpu like `docker stats` (percent of one CPU), memory without the page cache', () => {
    expect(usageFromDockerStats(STATS)).toEqual({ cpuPct: 40, memMb: 256, memLimitMb: 512 });
  });

  test('cgroup v1 cache field, missing precpu, zero system delta', () => {
    const v1 = {
      cpu_stats: { cpu_usage: { total_usage: 5, percpu_usage: [1, 2] }, system_cpu_usage: 10 },
      precpu_stats: { cpu_usage: { total_usage: 5 }, system_cpu_usage: 10 },
      memory_stats: {
        usage: 100 * MIB,
        limit: 200 * MIB,
        stats: { total_inactive_file: 36 * MIB },
      },
    };
    expect(usageFromDockerStats(v1)).toEqual({ cpuPct: 0, memMb: 64, memLimitMb: 200 });
    expect(usageFromDockerStats({})).toEqual({ cpuPct: 0, memMb: 0, memLimitMb: 0 });
  });
});

describe('Metrics', () => {
  const SBX = '00000000-0000-4000-8000-000000000001';

  function fixture(files: Record<string, string>) {
    let stat = STAT_A;
    const reads: string[] = [];
    const statfsPaths: string[] = [];
    let t = Date.parse('2026-10-24T10:00:00Z');
    const m = new Metrics({
      driver: {
        stats: async (cid: string) => {
          if (cid !== 'c1') throw new Error('gone');
          return { cpuPct: 12.5, memMb: 100, memLimitMb: 512 };
        },
      },
      listReady: async () => [
        { sandboxId: SBX, containerId: 'c1' },
        { sandboxId: '00000000-0000-4000-8000-000000000002', containerId: 'vanished' },
      ],
      hostProc: '/host/proc',
      hostRoot: '/host/root',
      now: () => t,
      readFile: async (p: string) => {
        reads.push(p);
        if (p.endsWith('/stat') && files[p] !== undefined) return stat;
        const v = files[p];
        if (v === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
        return v;
      },
      statfs: async (p: string) => {
        statfsPaths.push(p);
        if (p === '/host/root') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        // 100 GiB volume, 40 GiB free.
        return { blocks: 100 * 262144, bfree: 40 * 262144, bavail: 38 * 262144, bsize: 4096 };
      },
    });
    return {
      m,
      reads,
      statfsPaths,
      setStat: (s: string) => (stat = s),
      advance: (ms: number) => (t += ms),
    };
  }

  test('falls back to /proc and / when HOST_PROC / HOST_ROOT are missing', async () => {
    const f = fixture({ '/proc/stat': STAT_A, '/proc/meminfo': MEMINFO });
    await f.m.poll();
    f.setStat(STAT_B);
    f.advance(10_000);
    await f.m.poll();
    expect(f.reads).toContain('/host/proc/stat');
    expect(f.reads).toContain('/proc/stat');
    expect(f.reads).toContain('/proc/meminfo');
    expect(f.statfsPaths).toEqual(['/host/root', '/', '/host/root', '/']);

    const s = f.m.snapshot();
    expect(MetricsDto.parse(s)).toEqual(s);
    expect(s.host).toEqual({
      cpuPct: 36,
      memUsedMb: 3930,
      memTotalMb: 7860,
      diskUsedGb: 60,
      diskTotalGb: 100,
    });
    expect(s.at).toBe('2026-10-24T10:00:10.000Z');
    // The vanished container is skipped; disk is unknown until the GC measures it.
    expect(s.sandboxes).toEqual([
      { sandboxId: SBX, cpuPct: 12.5, memMb: 100, memLimitMb: 512, diskMb: null },
    ]);
    expect(f.m.usageOf(SBX)).toEqual({ cpuPct: 12.5, memMb: 100, memLimitMb: 512 });
    expect(f.m.usageOf('00000000-0000-4000-8000-000000000002')).toBeNull();

    f.m.setDiskMb(SBX, 321.5);
    expect(f.m.snapshot().sandboxes[0]!.diskMb).toBe(321.5);
  });

  test('reads HOST_PROC when it exists; history keeps the last 60 points', async () => {
    const f = fixture({ '/host/proc/stat': STAT_A, '/host/proc/meminfo': MEMINFO });
    for (let i = 0; i < HISTORY_POINTS + 5; i++) {
      f.advance(10_000);
      await f.m.poll();
    }
    expect(f.reads.every((p) => p.startsWith('/host/proc/'))).toBe(true);
    const s = f.m.snapshot();
    expect(HISTORY_POINTS).toBe(60);
    expect(s.history).toHaveLength(60);
    expect(s.history.at(-1)!.at).toBe(s.at);
    expect(s.history[0]!.at).toBe(new Date(Date.parse(s.at!) - 59 * 10_000).toISOString());
  });

  test('before the first poll the snapshot is empty but valid', () => {
    const f = fixture({});
    const s = f.m.snapshot();
    expect(MetricsDto.parse(s)).toEqual(s);
    expect(s.at).toBeNull();
    expect(s.sandboxes).toEqual([]);
  });
});

describe('GET /internal/metrics', () => {
  test('answers the latest snapshot behind the bearer token', async () => {
    const TOKEN = 'test-internal-token-0123456789';
    const metrics = new Metrics({
      driver: { stats: async () => ({ cpuPct: 1, memMb: 2, memLimitMb: 3 }) },
      listReady: async () => [],
      hostProc: '/host/proc',
      hostRoot: '/host/root',
      readFile: async (p: string) => (p.endsWith('meminfo') ? MEMINFO : STAT_A),
      statfs: async () => ({ blocks: 262144, bfree: 131072, bavail: 131072, bsize: 4096 }),
    });
    await metrics.poll();
    const config = loadConfig({
      DATABASE_URL: 'postgres://unused',
      INTERNAL_TOKEN: TOKEN,
      TICKET_SECRET: 'test-ticket-secret-0123456789abcdef',
      SANDBOX_DRIVER: 'runc-dev',
      NODE_ENV: 'test',
    });
    const app = await buildApp({
      config,
      driver: {} as SandboxDriver,
      db: {} as Db,
      scheduler: false,
      metrics,
    });
    try {
      const denied = await app.inject({ method: 'GET', url: '/internal/metrics' });
      expect(denied.statusCode).toBe(401);
      const r = await app.inject({
        method: 'GET',
        url: '/internal/metrics',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(r.statusCode).toBe(200);
      const body = MetricsDto.parse(r.json());
      expect(body.host).toMatchObject({ memTotalMb: 7860, diskUsedGb: 0.5, diskTotalGb: 1 });
      expect(body.history).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

describe('Metrics call timeouts', () => {
  test('a hung docker stats call is dropped; the poll still completes', async () => {
    const m = new Metrics({
      driver: { stats: () => new Promise<never>(() => {}) },
      listReady: async () => [
        { sandboxId: '00000000-0000-4000-8000-000000000001', containerId: 'c1' },
      ],
      hostProc: '/proc',
      hostRoot: '/',
      readFile: async (p: string) => (p.endsWith('meminfo') ? MEMINFO : STAT_A),
      statfs: async () => ({ blocks: 262144, bfree: 131072, bavail: 131072, bsize: 4096 }),
      callTimeoutMs: 50,
    });
    const t0 = Date.now();
    await m.poll();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(m.snapshot().sandboxes).toEqual([]);
    expect(m.snapshot().host.memTotalMb).toBe(7860);
  });
});
