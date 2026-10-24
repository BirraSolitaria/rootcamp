import type { SandboxClass } from '@rootcamp/api-contract';

/** Every sandbox container carries `rootcamp.sandbox=<sandboxId>`; GC and tests select by it. */
export const SANDBOX_LABEL = 'rootcamp.sandbox';
/** `rootcamp.user=<userId>`; absent on test sandboxes (no user). */
export const USER_LABEL = 'rootcamp.user';

export interface Limits {
  /** CPUs (`--cpus`). */
  cpu: number;
  /** `--memory` and `--memory-swap` (swap off), MiB. */
  memMb: number;
  /** `--pids-limit`. */
  pids: number;
}

/** Resource limits per class (spec §6.1). */
export const CLASS_LIMITS: Readonly<Record<SandboxClass, Readonly<Limits>>> = {
  light: { cpu: 0.5, memMb: 512, pids: 512 },
  docker: { cpu: 1.0, memMb: 1536, pids: 2048 },
  heavy: { cpu: 2.0, memMb: 2560, pids: 4096 },
};

export interface ContainerSpec {
  sandboxId: string;
  /** null for test sandboxes: the `rootcamp.user` label is omitted. */
  userId: string | null;
  image: string;
  class: SandboxClass;
  hostname: string;
  limits: Limits;
}

export interface ExecOptions {
  /** Passed to `timeout --kill-after=2 <timeoutSec>`. */
  timeoutSec: number;
  /** Extra `NAME=value` pairs; PATH is fixed to `/usr/sbin:/usr/bin:/sbin:/bin`. */
  env?: string[];
}

export interface ExecResult {
  /** Exit code of the script; 124 on timeout. */
  exitCode: number;
  /** First 64 KiB of stdout (stderr is drained, not kept), decoded as UTF-8. */
  output: string;
  timedOut: boolean;
}

/** An interactive `docker exec` with a TTY (the terminal WebSocket, Task 6). */
export interface TtyHandle {
  write(b: Buffer): void;
  onData(cb: (b: Buffer) => void): void;
  /** Resizes the exec's pseudo-terminal. */
  resize(cols: number, rows: number): Promise<void>;
  /** Detaches: ends the exec stream (the tmux session keeps running). */
  close(): void;
  /** Called once when the exec stream ends, whoever ended it. */
  onExit(cb: () => void): void;
  /** Flow control: stop / resume reading the exec's output (Task 6's token bucket). */
  pause(): void;
  resume(): void;
}

export interface ManagedContainer {
  containerId: string;
  sandboxId: string;
  running: boolean;
}

/**
 * Container operations sandboxd needs. Methods taking `id` take the container id that
 * `createContainer` returned.
 */
export interface SandboxDriver {
  readonly name: 'sysbox' | 'runc-dev';
  /** Makes sure the sandbox network exists (called once at startup). */
  ensureNetwork(): Promise<void>;
  /** Creates and starts the container; resolves with its id. */
  createContainer(s: ContainerSpec): Promise<string>;
  /** Resolves when the init system is up (`running` or `degraded`); rejects on timeout. */
  waitBoot(id: string, timeoutMs: number): Promise<void>;
  /** Runs `script` via stdin in `bash -s` as root under `timeout`. */
  exec(id: string, script: string, o: ExecOptions): Promise<ExecResult>;
  /** Attaches to (or creates) tmux session `main`. */
  execTty(id: string): Promise<TtyHandle>;
  /** `stop -t 10`, then `rm -v`; a missing container is not an error. */
  stopAndRemove(id: string): Promise<void>;
  /** Disk used by the sandbox, MiB. */
  diskUsageMb(id: string): Promise<number>;
  /** Every container with the `rootcamp.sandbox` label, running or not. */
  listManaged(): Promise<ManagedContainer[]>;
}
