import Docker from 'dockerode';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { Config } from './config.js';
import { DockerDriver } from './driver/docker.js';
import { RuncDevDriver } from './driver/runc-dev.js';
import type { SandboxDriver } from './driver/types.js';

/** Gateway of `rc-sbx` (spec §6.3): dnsmasq answering only for the mirrors. */
const SYSBOX_DNS = ['172.30.0.1'];

/** The driver `SANDBOX_DRIVER` names; dockerode reads DOCKER_HOST or uses /var/run/docker.sock. */
export function createDriver(
  cfg: Pick<Config, 'driver' | 'network' | 'hostRoot'>,
  docker = new Docker(),
): SandboxDriver {
  if (cfg.driver === 'runc-dev') return new RuncDevDriver({ docker, network: cfg.network });
  return new DockerDriver({
    docker,
    network: cfg.network,
    runtime: 'sysbox-runc',
    dns: SYSBOX_DNS,
    hostRoot: cfg.hostRoot,
  });
}

export interface AppDeps {
  config: Config;
  driver: SandboxDriver;
  /** Fastify logger option; default: off. */
  logger?: FastifyServerOptions['logger'];
  loggerInstance?: FastifyBaseLogger;
}

/** sandboxd's HTTP server. Internal routes (Task 4) and the terminal WebSocket (Task 6) mount here. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify(
    deps.loggerInstance
      ? { loggerInstance: deps.loggerInstance }
      : { logger: deps.logger ?? false },
  );
  app.get('/healthz', async () => ({ ok: true, driver: deps.driver.name }));
  return app;
}
