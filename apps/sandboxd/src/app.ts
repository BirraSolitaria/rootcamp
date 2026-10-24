import Docker from 'dockerode';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { Db } from '@rootcamp/db';
import type { Config } from './config.js';
import { DockerDriver } from './driver/docker.js';
import { RuncDevDriver } from './driver/runc-dev.js';
import type { SandboxDriver } from './driver/types.js';
import { Lifecycle } from './lifecycle.js';
import { internalRoutes } from './routes/internal.js';

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
  db: Db;
  /** Default: a `Lifecycle` over `db` and `driver` with the config's budget. */
  lifecycle?: Lifecycle;
  /** Run the 2 s scheduler loop (default true). */
  scheduler?: boolean;
  /** Fastify logger option; default: off. */
  logger?: FastifyServerOptions['logger'];
  loggerInstance?: FastifyBaseLogger;
}

/**
 * sandboxd's HTTP server: the internal REST (§5.3) and, from Task 6, the terminal WebSocket.
 * The app owns the lifecycle's scheduler loop: started on `ready`, stopped (in-flight starts
 * awaited) on `close`.
 */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify(
    deps.loggerInstance
      ? { loggerInstance: deps.loggerInstance }
      : { logger: deps.logger ?? false },
  );
  const lifecycle =
    deps.lifecycle ??
    new Lifecycle({
      db: deps.db,
      driver: deps.driver,
      budget: deps.config.budget,
      queueMax: deps.config.queueMax,
      hostRoot: deps.config.hostRoot,
      log: app.log,
    });
  app.decorate('lifecycle', lifecycle);
  app.get('/healthz', async () => ({ ok: true, driver: deps.driver.name }));
  await app.register(internalRoutes, { lifecycle, token: deps.config.internalToken });
  app.addHook('onReady', async () => {
    if (deps.scheduler !== false) lifecycle.start();
  });
  app.addHook('onClose', async () => {
    await lifecycle.close();
  });
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The sandbox lifecycle: Task 5 (GC, events) and Task 6 (terminal) hook into it. */
    lifecycle: Lifecycle;
  }
}
