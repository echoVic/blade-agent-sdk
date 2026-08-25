import { describe, expect, it } from 'vitest';
import { TenantAdmissionController } from '../TenantAdmissionController.js';

describe('TenantAdmissionController', () => {
  it('bounds concurrent and queued tenant commands', async () => {
    const controller = new TenantAdmissionController({
      maxConcurrentCommands: 1,
      maxQueuedCommands: 1,
      commandsPerMinute: 10,
    });
    const firstRelease = await controller.acquire('tenant-a');
    const second = controller.acquire('tenant-a');

    await expect(controller.acquire('tenant-a')).rejects.toMatchObject({
      protocolCode: 'OVERLOADED',
    });
    firstRelease();
    const secondRelease = await second;
    secondRelease();
  });

  it('isolates concurrency between tenants', async () => {
    const controller = new TenantAdmissionController({
      maxConcurrentCommands: 1,
      maxQueuedCommands: 1,
      commandsPerMinute: 10,
    });
    const [releaseA, releaseB] = await Promise.all([
      controller.acquire('tenant-a'),
      controller.acquire('tenant-b'),
    ]);
    releaseA();
    releaseB();
  });

  it('enforces a fixed-window command rate limit', async () => {
    let now = 0;
    const controller = new TenantAdmissionController(
      {
        maxConcurrentCommands: 1,
        maxQueuedCommands: 1,
        commandsPerMinute: 1,
      },
      () => now,
    );
    const release = await controller.acquire('tenant-a');
    release();
    await expect(controller.acquire('tenant-a')).rejects.toMatchObject({
      protocolCode: 'RATE_LIMITED',
    });
    now = 60_000;
    const nextRelease = await controller.acquire('tenant-a');
    nextRelease();
  });

  it('removes aborted commands from the bounded queue', async () => {
    const controller = new TenantAdmissionController({
      maxConcurrentCommands: 1,
      maxQueuedCommands: 1,
      commandsPerMinute: 10,
    });
    const firstRelease = await controller.acquire('tenant-a');
    const abortController = new AbortController();
    const queued = controller.acquire('tenant-a', abortController.signal);
    abortController.abort(new Error('cancelled'));
    await expect(queued).rejects.toThrow('cancelled');
    firstRelease();

    const release = await controller.acquire('tenant-a');
    release();
  });
});
