import type Docker from 'dockerode';
import { DockerDriver } from './docker.js';
import type { ContainerSpec } from './types.js';

/** Every practice image is replaced by this one under runc-dev (Alpine, bash, tmux, coreutils). */
export const TEST_SHELL_IMAGE = 'rc/test-shell';

export interface RuncDevDriverOptions {
  docker: Docker;
  /** Default `rc-sbx-dev`. */
  network?: string;
  /** `SANDBOXD_INSTANCE`; default `default`. */
  instance?: string;
}

/**
 * Dev/test driver on plain runc (never in production: `assertDriverAllowed`). No systemd, so
 * no boot wait; no inner Docker, so disk usage is the writable layer alone.
 */
export class RuncDevDriver extends DockerDriver {
  override readonly name = 'runc-dev';

  constructor(opts: RuncDevDriverOptions) {
    super({
      docker: opts.docker,
      network: opts.network ?? 'rc-sbx-dev',
      ...(opts.instance ? { instance: opts.instance } : {}),
    });
  }

  /** Creates the internal (no route out), ICC-off bridge if it is missing. */
  override async ensureNetwork(): Promise<void> {
    const net = this.docker.getNetwork(this.network);
    try {
      const info = (await net.inspect()) as { Internal?: boolean };
      if (!info.Internal) throw new Error(`docker network ${this.network} is not internal`);
      return;
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode !== 404) throw err;
    }
    try {
      await this.docker.createNetwork({
        Name: this.network,
        Driver: 'bridge',
        Internal: true,
        Options: { 'com.docker.network.bridge.enable_icc': 'false' },
        Labels: { 'rootcamp.network': 'sandbox-dev' },
      });
    } catch (err) {
      // 409: another sandboxd (or a test run) created it first.
      if ((err as { statusCode?: number }).statusCode !== 409) throw err;
    }
  }

  override createContainer(s: ContainerSpec): Promise<string> {
    return super.createContainer({ ...s, image: TEST_SHELL_IMAGE });
  }

  /** No systemd to wait for: the container is usable once started. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override async waitBoot(_id: string, _timeoutMs: number): Promise<void> {}

  override diskUsageMb(id: string): Promise<number> {
    return this.sizeRwMb(id);
  }
}
