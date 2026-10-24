import { readFile as fsReadFile, statfs as fsStatfs } from 'node:fs/promises';
import type {
  HostMetricsDto,
  HostMetricsPointDto,
  MetricsDto,
  SandboxMetricsDto,
  SandboxUsageDto,
} from '@rootcamp/api-contract';
import type { ContainerStats } from './driver/types.js';
import { CALL_TIMEOUT_MS, withTimeout } from './timeout.js';

/** Spec §11.4: a poll every 10 s, the last 60 points kept in memory. */
export const METRICS_INTERVAL_MS = 10_000;
export const HISTORY_POINTS = 60;

const MIB = 1024 * 1024;
const GIB = 1024 ** 3;
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---- pure parsers -------------------------------------------------------------------------

export interface CpuTimes {
  /** All jiffies (user … steal). */
  total: number;
  /** idle + iowait. */
  idle: number;
}

/**
 * The aggregate `cpu` line of `/proc/stat`. Fields: user nice system idle iowait irq softirq
 * steal guest guest_nice; guest and guest_nice are already included in user / nice, so only
 * the first eight are summed.
 */
export function parseProcStat(text: string): CpuTimes {
  const line = text.split('\n').find((l) => /^cpu\s/.test(l));
  if (!line) throw new Error('no aggregate cpu line in /proc/stat');
  const f = line.trim().split(/\s+/).slice(1, 9).map(Number);
  const total = f.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  return { total, idle: (f[3] ?? 0) + (f[4] ?? 0) };
}

/** Busy share of the jiffies between two snapshots, 0–100 (0 if no time passed / reset). */
export function cpuPctBetween(a: CpuTimes, b: CpuTimes): number {
  const dTotal = b.total - a.total;
  const dIdle = b.idle - a.idle;
  if (dTotal <= 0 || dIdle < 0) return 0;
  return round1(Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100)));
}

/** `/proc/meminfo` → MiB; used = MemTotal − MemAvailable (free + buffers + cached if absent). */
export function parseMeminfo(text: string): { totalMb: number; usedMb: number } {
  const kb = new Map<string, number>();
  for (const l of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)/.exec(l);
    if (m) kb.set(m[1]!, Number(m[2]));
  }
  const total = kb.get('MemTotal') ?? 0;
  const available =
    kb.get('MemAvailable') ??
    (kb.get('MemFree') ?? 0) + (kb.get('Buffers') ?? 0) + (kb.get('Cached') ?? 0);
  return { totalMb: round1(total / 1024), usedMb: round1(Math.max(0, total - available) / 1024) };
}

interface DockerStatsJson {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> };
}

/**
 * One `docker stats --no-stream` sample → usage, computed as the docker CLI does: CPU is the
 * container's share of the host's CPU time times the number of CPUs (percent of one CPU);
 * memory is usage minus the reclaimable page cache (`inactive_file` on cgroup v2,
 * `total_inactive_file` on v1).
 */
export function usageFromDockerStats(raw: unknown): ContainerStats {
  const s = (raw ?? {}) as DockerStatsJson;
  const cpuDelta =
    (s.cpu_stats?.cpu_usage?.total_usage ?? 0) - (s.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const sysDelta = (s.cpu_stats?.system_cpu_usage ?? 0) - (s.precpu_stats?.system_cpu_usage ?? 0);
  const cpus = s.cpu_stats?.online_cpus || s.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  const cpuPct = cpuDelta > 0 && sysDelta > 0 ? round1((cpuDelta / sysDelta) * cpus * 100) : 0;
  const st = s.memory_stats?.stats ?? {};
  const cache = st.inactive_file ?? st.total_inactive_file ?? 0;
  const usage = s.memory_stats?.usage ?? 0;
  return {
    cpuPct,
    memMb: round1(Math.max(0, usage - (cache < usage ? cache : 0)) / MIB),
    memLimitMb: round1((s.memory_stats?.limit ?? 0) / MIB),
  };
}

// ---- the poller ---------------------------------------------------------------------------

interface StatfsLike {
  blocks: number;
  bfree: number;
  bavail: number;
  bsize: number;
}

type Log = { warn(obj: object, msg?: string): void };

export interface MetricsDeps {
  driver: { stats(containerId: string): Promise<ContainerStats> };
  /** The `ready` sandboxes and their containers (a DB read in the app). */
  listReady: () => Promise<{ sandboxId: string; containerId: string }[]>;
  /** `HOST_PROC`; `/proc` is used when `<hostProc>/stat` cannot be read. */
  hostProc: string;
  /** `HOST_ROOT`; `/` is used when it cannot be statfs'ed. */
  hostRoot: string;
  now?: () => number;
  intervalMs?: number;
  /** Injected for tests; default node:fs. */
  readFile?: (path: string) => Promise<string>;
  statfs?: (path: string) => Promise<StatfsLike>;
  log?: Log;
  /** Limit per stats / statfs / DB call (default `CALL_TIMEOUT_MS`, 20 s). */
  callTimeoutMs?: number;
}

const EMPTY_HOST: HostMetricsDto = {
  cpuPct: 0,
  memUsedMb: 0,
  memTotalMb: 0,
  diskUsedGb: 0,
  diskTotalGb: 0,
};

/**
 * Host and per-sandbox gauges for `GET /internal/metrics` and `SandboxView.usage` (spec §11.4).
 * `poll()` every 10 s; the host series keeps the last 60 points. Per-sandbox disk comes from
 * the GC, which measures it once a minute (`setDiskMb`).
 */
export class Metrics {
  private readonly now: () => number;
  private readonly readFile: (path: string) => Promise<string>;
  private readonly statfs: (path: string) => Promise<StatfsLike>;
  private prevCpu: CpuTimes | undefined;
  private at: number | null = null;
  private host: HostMetricsDto = EMPTY_HOST;
  private history: HostMetricsPointDto[] = [];
  private usage = new Map<string, ContainerStats>();
  private disk = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;

  constructor(private readonly deps: MetricsDeps) {
    this.now = deps.now ?? Date.now;
    this.readFile = deps.readFile ?? ((p) => fsReadFile(p, 'utf8'));
    this.statfs = deps.statfs ?? ((p) => fsStatfs(p));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.safePoll(),
      this.deps.intervalMs ?? METRICS_INTERVAL_MS,
    );
    this.timer.unref();
    void this.safePoll();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.polling;
  }

  private async safePoll(): Promise<void> {
    if (this.polling) return;
    this.polling = this.poll()
      .catch((err: unknown) => this.deps.log?.warn({ err }, 'metrics poll failed'))
      .finally(() => (this.polling = undefined));
    await this.polling;
  }

  /** One sample of the host and every ready sandbox. */
  async poll(): Promise<void> {
    const [host, sandboxes] = await Promise.all([this.pollHost(), this.pollSandboxes()]);
    this.at = this.now();
    this.host = host;
    this.usage = sandboxes;
    for (const id of this.disk.keys()) if (!sandboxes.has(id)) this.disk.delete(id);
    this.history.push({ at: new Date(this.at).toISOString(), ...host });
    if (this.history.length > HISTORY_POINTS)
      this.history.splice(0, this.history.length - HISTORY_POINTS);
  }

  /** A hung dockerd / filesystem call must not stall the poll (it is not reentrant). */
  private limit<T>(p: Promise<T>, what: string): Promise<T> {
    return withTimeout(p, this.deps.callTimeoutMs ?? CALL_TIMEOUT_MS, what);
  }

  private async procFile(name: string): Promise<string> {
    try {
      return await this.readFile(`${this.deps.hostProc}/${name}`);
    } catch {
      return this.readFile(`/proc/${name}`);
    }
  }

  private async pollHost(): Promise<HostMetricsDto> {
    const [stat, meminfo, fs] = await Promise.all([
      this.procFile('stat'),
      this.procFile('meminfo'),
      this.limit(this.statfs(this.deps.hostRoot), 'statfs').catch(() =>
        this.limit(this.statfs('/'), 'statfs'),
      ),
    ]);
    const cpu = parseProcStat(stat);
    const cpuPct = this.prevCpu ? cpuPctBetween(this.prevCpu, cpu) : 0;
    this.prevCpu = cpu;
    const mem = parseMeminfo(meminfo);
    return {
      cpuPct,
      memUsedMb: mem.usedMb,
      memTotalMb: mem.totalMb,
      diskUsedGb: round2(((fs.blocks - fs.bfree) * fs.bsize) / GIB),
      diskTotalGb: round2((fs.blocks * fs.bsize) / GIB),
    };
  }

  private async pollSandboxes(): Promise<Map<string, ContainerStats>> {
    const ready = await this.limit(this.deps.listReady(), 'listReady');
    const out = new Map<string, ContainerStats>();
    await Promise.all(
      ready.map(async (r) => {
        try {
          out.set(r.sandboxId, await this.limit(this.deps.driver.stats(r.containerId), 'stats'));
        } catch {
          // Stopped or removed meanwhile.
        }
      }),
    );
    return out;
  }

  /** `SandboxView.usage` of a ready sandbox: the latest sample, null if none. */
  usageOf(sandboxId: string): SandboxUsageDto | null {
    return this.usage.get(sandboxId) ?? null;
  }

  /** The GC's latest disk measurement of a sandbox, MiB. */
  setDiskMb(sandboxId: string, mb: number): void {
    this.disk.set(sandboxId, round1(mb));
  }

  snapshot(): MetricsDto {
    const sandboxes: SandboxMetricsDto[] = [...this.usage].map(([sandboxId, u]) => ({
      sandboxId,
      ...u,
      diskMb: this.disk.get(sandboxId) ?? null,
    }));
    return {
      at: this.at === null ? null : new Date(this.at).toISOString(),
      host: this.host,
      sandboxes,
      history: [...this.history],
    };
  }
}
