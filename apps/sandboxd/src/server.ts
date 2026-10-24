import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { buildApp, createDriver } from './app.js';
import { assertDriverAllowed, loadConfig, type Config } from './config.js';

let config: Config;
try {
  config = loadConfig(process.env);
  assertDriverAllowed(config);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const log = pino({ level: config.nodeEnv === 'production' ? 'info' : 'debug' });
const driver = createDriver(config);

let app: FastifyInstance | undefined;
let shuttingDown = false;

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${reason}, shutting down`);
  try {
    await app?.close();
  } catch (err) {
    log.error({ err }, 'error closing http server');
    exitCode = 1;
  }
  process.exit(exitCode);
}
process.once('SIGTERM', () => void shutdown('SIGTERM received'));
process.once('SIGINT', () => void shutdown('SIGINT received'));

try {
  await driver.ensureNetwork();
  app = await buildApp({ config, driver, loggerInstance: log });
  await app.listen({ port: config.port, host: config.host });
  log.info({ driver: driver.name, network: config.network }, 'sandboxd started');
} catch (err) {
  log.error({ err }, 'sandboxd failed to start');
  await shutdown('startup failure', 1);
}
