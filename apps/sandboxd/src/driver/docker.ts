import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { promisify } from 'node:util';
import type Docker from 'dockerode';
import {
  SANDBOX_LABEL,
  USER_LABEL,
  type ContainerSpec,
  type ExecOptions,
  type ExecResult,
  type ManagedContainer,
  type SandboxDriver,
  type TtyHandle,
} from './types.js';

const execFileP = promisify(execFile);

/** `exec` keeps this much stdout; the rest is read and dropped so the process never blocks. */
export const OUTPUT_CAP_BYTES = 64 * 1024;
/** PATH for scripts (spec §6.7): checks call binaries the user cannot shadow via ~/bin. */
export const EXEC_PATH = 'PATH=/usr/sbin:/usr/bin:/sbin:/bin';
/** `timeout --kill-after` grace, seconds. */
const KILL_AFTER_SEC = 2;
/** Beyond timeout + kill-after, sandboxd stops waiting for the exec stream itself. */
const STREAM_GRACE_MS = 3000;
const STOP_TIMEOUT_SEC = 10;
const MIB = 1024 * 1024;

export const containerName = (sandboxId: string) => `rc-sbx-${sandboxId.slice(0, 8)}`;

/** HTTP status of a dockerode error, if any. */
const statusOf = (err: unknown): number | undefined =>
  (err as { statusCode?: number } | null)?.statusCode;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Shell-quotes one argument for `sh -c`. */
const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * Splits Docker's multiplexed (non-TTY) attach stream: frames of an 8-byte header
 * (stream type, 3 zero bytes, uint32 BE length) followed by the payload.
 */
export function demux(
  stream: NodeJS.ReadableStream,
  onStdout: (b: Buffer) => void,
  onStderr: (b: Buffer) => void,
): void {
  let pending: Buffer = Buffer.alloc(0);
  stream.on('data', (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let off = 0;
    while (pending.length - off >= 8) {
      const type = pending[off];
      const len = pending.readUInt32BE(off + 4);
      if (pending.length - off - 8 < len) break;
      const payload = pending.subarray(off + 8, off + 8 + len);
      if (type === 2) onStderr(payload);
      else onStdout(payload);
      off += 8 + len;
    }
    pending = off === 0 ? pending : Buffer.from(pending.subarray(off));
  });
}

/** Collects up to `cap` bytes; further input is counted and discarded. */
class CappedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  constructor(private readonly cap: number) {}
  push(b: Buffer): void {
    const room = this.cap - this.size;
    if (room <= 0) return;
    const part = b.length > room ? b.subarray(0, room) : b;
    this.chunks.push(Buffer.from(part));
    this.size += part.length;
  }
  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

export interface DockerDriverOptions {
  docker: Docker;
  /** Docker network the sandboxes join (`rc-sbx`, or `rc-sbx-dev` for runc-dev). */
  network: string;
  /** `--runtime` (`sysbox-runc`); omitted: the daemon default (runc). */
  runtime?: string;
  /** `--dns` servers (`172.30.0.1` on the Sysbox stand). */
  dns?: string[];
  /** Host `/` mounted read-only (`HOST_ROOT`): for measuring Sysbox's inner Docker dirs. */
  hostRoot?: string;
}

/**
 * The dockerode implementation shared by both drivers. As is, it is the Sysbox driver
 * (M4b: systemd boot wait, inner-Docker disk usage); `RuncDevDriver` overrides the parts
 * a plain runc dev container cannot do.
 */
export class DockerDriver implements SandboxDriver {
  readonly name: 'sysbox' | 'runc-dev' = 'sysbox';
  protected readonly docker: Docker;
  protected readonly network: string;

  constructor(protected readonly opts: DockerDriverOptions) {
    this.docker = opts.docker;
    this.network = opts.network;
  }

  /** The Sysbox network (subnet, gateway, ICC off) belongs to infra; only check it exists. */
  async ensureNetwork(): Promise<void> {
    try {
      await this.docker.getNetwork(this.network).inspect();
    } catch (err) {
      if (statusOf(err) === 404) {
        throw new Error(`docker network ${this.network} does not exist (created by infra)`);
      }
      throw err;
    }
  }

  async createContainer(s: ContainerSpec): Promise<string> {
    const labels: Record<string, string> = { [SANDBOX_LABEL]: s.sandboxId };
    if (s.userId) labels[USER_LABEL] = s.userId;
    const memory = Math.round(s.limits.memMb * MIB);
    const container = await this.docker.createContainer({
      name: containerName(s.sandboxId),
      Image: s.image,
      Hostname: s.hostname,
      Labels: labels,
      HostConfig: {
        ...(this.opts.runtime ? { Runtime: this.opts.runtime } : {}),
        NanoCpus: Math.round(s.limits.cpu * 1e9),
        Memory: memory,
        MemorySwap: memory,
        PidsLimit: s.limits.pids,
        Ulimits: [{ Name: 'nofile', Soft: 4096, Hard: 4096 }],
        NetworkMode: this.network,
        ...(this.opts.dns ? { Dns: this.opts.dns } : {}),
        LogConfig: { Type: 'none', Config: {} },
        // Spelled out so a daemon default can never turn them on. No Binds/Mounts,
        // CapAdd or SecurityOpt are ever passed (Global Constraints).
        Privileged: false,
        RestartPolicy: { Name: 'no' },
      },
    });
    try {
      await container.start();
    } catch (err) {
      await container.remove({ force: true, v: true }).catch(() => {});
      throw err;
    }
    return container.id;
  }

  /** `systemctl is-system-running --wait`; `running` and `degraded` count as booted. */
  async waitBoot(id: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
      const left = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
      const r = await this.exec(id, 'systemctl is-system-running --wait', { timeoutSec: left });
      last = r.output.trim();
      if (last === 'running' || last === 'degraded') return;
      // systemd not up enough to answer yet (`offline`, bus errors): retry.
      await sleep(500);
    }
    throw new Error(`sandbox did not boot in ${timeoutMs} ms (last state: ${last || 'none'})`);
  }

  async exec(id: string, script: string, o: ExecOptions): Promise<ExecResult> {
    const timeoutSec = Math.max(1, Math.ceil(o.timeoutSec));
    const exec = await this.docker.getContainer(id).exec({
      Cmd: ['timeout', `--kill-after=${KILL_AFTER_SEC}`, String(timeoutSec), 'bash', '-s'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: 'root',
      WorkingDir: '/root',
      Env: [EXEC_PATH, ...(o.env ?? [])],
    });
    const started = Date.now();
    const stream = (await exec.start({ hijack: true, stdin: true })) as Duplex;
    const stdout = new CappedBuffer(OUTPUT_CAP_BYTES);
    demux(
      stream,
      (b) => stdout.push(b),
      () => {},
    );

    let guard: NodeJS.Timeout | undefined;
    const ended = await new Promise<boolean>((resolve) => {
      stream.once('end', () => resolve(true));
      stream.once('close', () => resolve(true));
      stream.once('error', () => resolve(true));
      // A background process can hold the output pipe open after the script exits.
      guard = setTimeout(
        () => resolve(false),
        (timeoutSec + KILL_AFTER_SEC) * 1000 + STREAM_GRACE_MS,
      );
      // Script on stdin, then EOF (half-close) so `bash -s` runs it and exits.
      stream.end(script.endsWith('\n') ? script : `${script}\n`);
    });
    clearTimeout(guard);
    if (!ended) stream.destroy();

    const exitCode = await this.execExitCode(exec);
    const elapsedMs = Date.now() - started;
    // 124: `timeout` fired; 137: it had to SIGKILL after the grace period.
    const timedOut =
      exitCode === 124 ||
      ((exitCode === 137 || exitCode === null) && elapsedMs >= timeoutSec * 1000);
    if (timedOut) return { exitCode: 124, output: stdout.toString(), timedOut: true };
    // Still running with the stream gone (e.g. dockerd lost it): report as a failure.
    return { exitCode: exitCode ?? 1, output: stdout.toString(), timedOut: false };
  }

  /** The exec's exit code; dockerd may lag a moment behind the end of the stream. */
  private async execExitCode(exec: Docker.Exec): Promise<number | null> {
    for (let i = 0; i < 40; i++) {
      const info = await exec.inspect();
      if (!info.Running && info.ExitCode !== null) return info.ExitCode;
      await sleep(50);
    }
    return null;
  }

  async execTty(id: string): Promise<TtyHandle> {
    const container = this.docker.getContainer(id);
    // Marks this tmux client so close() can detach exactly it (other connections stay).
    const clientId = randomUUID();
    const exec = await container.exec({
      Cmd: ['tmux', 'new-session', '-A', '-s', 'main'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      User: 'root',
      WorkingDir: '/root',
      Env: ['TERM=xterm-256color', 'LANG=C.UTF-8', `RC_TTY_CLIENT=${clientId}`],
    });
    const stream = (await exec.start({ hijack: true, stdin: true, Tty: true })) as Duplex;

    let exited = false;
    const exitCbs: (() => void)[] = [];
    const onEnd = () => {
      if (exited) return;
      exited = true;
      for (const cb of exitCbs) cb();
    };
    stream.once('end', onEnd);
    stream.once('close', onEnd);
    stream.on('error', onEnd);

    // Dropping the connection alone leaves the tmux client running in the container,
    // so close() terminates our client (tmux detaches it; the session lives on).
    const detach = `for p in $(tmux list-clients -F '#{client_pid}' 2>/dev/null); do
  tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -qx ${shq(`RC_TTY_CLIENT=${clientId}`)} && kill $p
done; exit 0`;

    return {
      write: (b) => {
        if (!exited) stream.write(b);
      },
      onData: (cb) => {
        stream.on('data', cb);
      },
      resize: async (cols, rows) => {
        await exec.resize({ w: cols, h: rows });
      },
      close: () => {
        if (exited) return;
        const fallback = setTimeout(() => stream.destroy(), STREAM_GRACE_MS);
        this.exec(id, detach, { timeoutSec: 5 })
          .catch(() => {})
          .finally(() => {
            clearTimeout(fallback);
            stream.destroy();
          });
      },
      onExit: (cb) => {
        if (exited) cb();
        else exitCbs.push(cb);
      },
      pause: () => {
        stream.pause();
      },
      resume: () => {
        stream.resume();
      },
    };
  }

  async stopAndRemove(id: string): Promise<void> {
    const container = this.docker.getContainer(id);
    try {
      await container.stop({ t: STOP_TIMEOUT_SEC });
    } catch (err) {
      // 304: already stopped; 404: already gone.
      const code = statusOf(err);
      if (code === 404) return;
      if (code !== 304) throw err;
    }
    try {
      await container.remove({ v: true, force: true });
    } catch (err) {
      // 404: gone; 409: removal already in progress.
      const code = statusOf(err);
      if (code !== 404 && code !== 409) throw err;
    }
  }

  /** Writable layer plus the inner Docker's directory that Sysbox keeps on the host. */
  async diskUsageMb(id: string): Promise<number> {
    const rw = await this.sizeRwMb(id);
    if (!this.opts.hostRoot) return rw;
    const info = await this.docker.getContainer(id).inspect();
    const dir = join(this.opts.hostRoot, 'var/lib/sysbox/docker', info.Id);
    try {
      const { stdout } = await execFileP('du', ['-sxm', dir]);
      return rw + (Number.parseInt(stdout, 10) || 0);
    } catch {
      return rw; // no inner Docker dir (class light) or du unavailable
    }
  }

  protected async sizeRwMb(id: string): Promise<number> {
    // `size=true` is a valid inspect query parameter the typings do not list.
    const info = (await this.docker
      .getContainer(id)
      .inspect({ size: true } as Docker.ContainerInspectOptions)) as { SizeRw?: number };
    return (info.SizeRw ?? 0) / MIB;
  }

  async listManaged(): Promise<ManagedContainer[]> {
    const list = await this.docker.listContainers({
      all: true,
      filters: { label: [SANDBOX_LABEL] },
    });
    return list.map((c) => ({
      containerId: c.Id,
      sandboxId: c.Labels[SANDBOX_LABEL] ?? '',
      running: c.State === 'running',
    }));
  }
}
