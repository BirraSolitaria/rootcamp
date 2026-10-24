import Docker from 'dockerode';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import { sandboxes, type Db } from '@rootcamp/db';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Config } from './config.js';
import { DockerDriver } from './driver/docker.js';
import { RuncDevDriver } from './driver/runc-dev.js';
import type { SandboxDriver } from './driver/types.js';
import { watchEvents, type EventWatcher } from './events.js';
import { Gc } from './gc.js';
import { Lifecycle } from './lifecycle.js';
import { Metrics } from './metrics.js';
import { reconcileOnStart } from './reconcile.js';
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
  /**
   * Background housekeeping on `ready`: docker events, start-up reconcile, the 30 s GC (with
   * the daily prune) and the 10 s metrics poll. Default false: the GC removes every labelled
   * container it has no row for, so it must only run where this database owns the daemon's
   * sandboxes — server.ts turns it on; test suites sharing a dockerd do not.
   */
  housekeeping?: boolean;
  /** Default: a `Metrics` over `driver` and the ready rows of `db`. */
  metrics?: Metrics;
  /** Open terminal WebSockets per sandbox for the GC's idle rule (Task 6); default none. */
  connectionCount?: (sandboxId: string) => number;
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
  const metrics =
    deps.metrics ??
    new Metrics({
      driver: deps.driver,
      listReady: async () =>
        (await deps.db
          .select({ sandboxId: sandboxes.id, containerId: sandboxes.containerId })
          .from(sandboxes)
          .where(and(eq(sandboxes.state, 'ready'), isNotNull(sandboxes.containerId)))) as {
          sandboxId: string;
          containerId: string;
        }[],
      hostProc: deps.config.hostProc,
      hostRoot: deps.config.hostRoot,
      log: app.log,
    });
  const lifecycle =
    deps.lifecycle ??
    new Lifecycle({
      db: deps.db,
      driver: deps.driver,
      budget: deps.config.budget,
      queueMax: deps.config.queueMax,
      hostRoot: deps.config.hostRoot,
      usageOf: (id) => metrics.usageOf(id),
      log: app.log,
    });
  const gc = new Gc({
    db: deps.db,
    driver: deps.driver,
    lifecycle,
    ...(deps.connectionCount ? { connectionCount: deps.connectionCount } : {}),
    onDiskUsage: (id, mb) => metrics.setDiskMb(id, mb),
    log: app.log,
  });
  app.decorate('lifecycle', lifecycle);
  app.decorate('gc', gc);
  app.decorate('metrics', metrics);
  let events: EventWatcher | undefined;
  app.get('/healthz', async () => ({ ok: true, driver: deps.driver.name }));
  await app.register(internalRoutes, { lifecycle, metrics, token: deps.config.internalToken });
  app.addHook('onReady', async () => {
    if (deps.housekeeping) {
      // Events first, so a container dying during the reconcile is not missed; reconcile
      // before the scheduler, so no start of this process is mistaken for a leftover.
      events = watchEvents({ driver: deps.driver, lifecycle, log: app.log });
      await events.ready;
      await reconcileOnStart({ db: deps.db, driver: deps.driver, lifecycle, log: app.log });
      gc.start();
      metrics.start();
    }
    if (deps.scheduler !== false) lifecycle.start();
  });
  app.addHook('onClose', async () => {
    events?.stop();
    await gc.close();
    await metrics.close();
    await lifecycle.close();
  });
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The sandbox lifecycle: Task 5 (GC, events) and Task 6 (terminal) hook into it. */
    lifecycle: Lifecycle;
    /** The GC; Task 6 calls `gc.setConnectionCount(...)` with its terminal registry. */
    gc: Gc;
    metrics: Metrics;
  }
}
