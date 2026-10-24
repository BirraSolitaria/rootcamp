import { randomUUID } from 'node:crypto';
import Docker from 'dockerode';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { RuncDevDriver } from '../src/driver/runc-dev.js';
import { CLASS_LIMITS, INSTANCE_LABEL, SANDBOX_LABEL, USER_LABEL } from '../src/driver/types.js';

const docker = new Docker();
const dockerAvailable = await docker.ping().then(
  () => true,
  () => false,
);

const NETWORK = 'rc-sbx-dev';

/** Removes the containers labelled `rootcamp.sandbox=<one of ids>`; nothing else is touched. */
async function sweep(ids: string[]): Promise<void> {
  const list = await docker.listContainers({ all: true, filters: { label: [SANDBOX_LABEL] } });
  for (const c of list) {
    if (!ids.includes(c.Labels[SANDBOX_LABEL] ?? '')) continue;
    await docker
      .getContainer(c.Id)
      .remove({ force: true, v: true })
      .catch(() => {});
  }
}

describe.runIf(dockerAvailable)('runc-dev driver (real dockerd)', () => {
  const instance = `test-${randomUUID().slice(0, 8)}`;
  const driver = new RuncDevDriver({ docker, network: NETWORK, instance });
  const sandboxId = randomUUID();
  const userId = randomUUID();
  const created: string[] = [sandboxId];
  let containerId = '';

  beforeAll(async () => {
    await driver.ensureNetwork();
    containerId = await driver.createContainer({
      sandboxId,
      userId,
      image: 'rc/linux-base:24.04',
      class: 'light',
      hostname: 'web-01',
      limits: CLASS_LIMITS.light,
    });
    await driver.waitBoot(containerId, 60_000);
  });

  afterAll(async () => {
    if (containerId) await driver.stopAndRemove(containerId).catch(() => {});
    await sweep(created);
  });

  test('creates the container with the class limits, labels and no host access', async () => {
    const info = await docker.getContainer(containerId).inspect();
    expect(info.Name).toBe(`/rc-sbx-${sandboxId.slice(0, 8)}`);
    expect(info.Config.Image).toBe('rc/test-shell');
    expect(info.Config.Hostname).toBe('web-01');
    expect(info.Config.Labels).toMatchObject({ [SANDBOX_LABEL]: sandboxId, [USER_LABEL]: userId });
    const hc = info.HostConfig;
    expect(hc.Privileged).toBe(false);
    expect(hc.Binds ?? []).toEqual([]);
    expect(info.Mounts).toEqual([]);
    expect(hc.CapAdd ?? []).toEqual([]);
    expect(hc.SecurityOpt ?? []).not.toContain('seccomp=unconfined');
    expect(hc.NanoCpus).toBe(0.5e9);
    expect(hc.Memory).toBe(512 * 1024 * 1024);
    expect(hc.MemorySwap).toBe(512 * 1024 * 1024);
    expect(hc.PidsLimit).toBe(512);
    expect(hc.Ulimits).toEqual([{ Name: 'nofile', Soft: 4096, Hard: 4096 }]);
    expect(hc.LogConfig?.Type).toBe('none');
    expect(hc.NetworkMode).toBe(NETWORK);
    expect(info.State.Running).toBe(true);
  });

  test('the dev network is internal', async () => {
    const net = await docker.getNetwork(NETWORK).inspect();
    expect(net.Internal).toBe(true);
  });

  test('exec returns the exit code and stdout', async () => {
    const r = await driver.exec(containerId, 'echo hi; exit 3', { timeoutSec: 10 });
    expect(r).toEqual({ exitCode: 3, output: 'hi\n', timedOut: false });
  });

  test('exec runs as root with a fixed PATH, passes env and keeps stderr out of output', async () => {
    const r = await driver.exec(
      containerId,
      'id -u; echo "$PATH"; echo "$GREETING"; echo err >&2',
      { timeoutSec: 10, env: ['GREETING=hello world'] },
    );
    expect(r).toEqual({
      exitCode: 0,
      output: '0\n/usr/sbin:/usr/bin:/sbin:/bin\nhello world\n',
      timedOut: false,
    });
  });

  test('exec times out with code 124 well before the command would finish', async () => {
    const started = Date.now();
    const r = await driver.exec(containerId, 'sleep 5', { timeoutSec: 1 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  test('exec caps the output at 64 KB and keeps draining the rest', async () => {
    const r = await driver.exec(
      containerId,
      "head -c 1000000 /dev/zero | tr '\\0' a; echo; exit 7",
      { timeoutSec: 20 },
    );
    expect(r.exitCode).toBe(7);
    expect(r.timedOut).toBe(false);
    expect(r.output.length).toBe(64 * 1024);
  });

  test('execTty attaches to tmux session "main" and resizes', async () => {
    const tty = await driver.execTty(containerId);
    let out = '';
    tty.onData((b) => {
      out += b.toString('utf8');
    });
    await tty.resize(120, 40);
    tty.write(Buffer.from('echo $((6*7))-$(tput cols)\r'));
    const deadline = Date.now() + 10_000;
    while (!out.includes('42-120') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(out).toContain('42-120');
    const exited = new Promise<void>((resolve) => tty.onExit(() => resolve()));
    tty.close();
    await exited;
    // close() detaches our tmux client and leaves the session for the next connection.
    const s = await driver.exec(
      containerId,
      'tmux has-session -t main && echo alive; tmux list-clients | wc -l',
      { timeoutSec: 5 },
    );
    expect(s.output).toBe('alive\n0\n');
  });

  test('listManaged and diskUsageMb see the container', async () => {
    const managed = await driver.listManaged();
    expect(managed).toContainEqual({ containerId, sandboxId, running: true });
    expect(await driver.diskUsageMb(containerId)).toBeGreaterThanOrEqual(0);
  });

  test('containers carry the instance label; another instance never lists them', async () => {
    const info = await docker.getContainer(containerId).inspect();
    expect(info.Config.Labels[INSTANCE_LABEL]).toBe(instance);
    const other = new RuncDevDriver({ docker, network: NETWORK, instance: `${instance}-x` });
    expect((await other.listManaged()).map((c) => c.containerId)).not.toContain(containerId);
    expect((await driver.listManaged()).every((c) => c.containerId !== '')).toBe(true);
  });

  test('a sandbox without a user has no rootcamp.user label; stopAndRemove is idempotent', async () => {
    const id = randomUUID();
    created.push(id);
    const cid = await driver.createContainer({
      sandboxId: id,
      userId: null,
      image: 'rc/linux-base:24.04',
      class: 'light',
      hostname: 'test',
      limits: CLASS_LIMITS.light,
    });
    try {
      const info = await docker.getContainer(cid).inspect();
      expect(info.Config.Labels[SANDBOX_LABEL]).toBe(id);
      expect(info.Config.Labels).not.toHaveProperty(USER_LABEL);
    } finally {
      await driver.stopAndRemove(cid);
    }
    await expect(docker.getContainer(cid).inspect()).rejects.toMatchObject({ statusCode: 404 });
    await expect(driver.stopAndRemove(cid)).resolves.toBeUndefined();
  });
});
