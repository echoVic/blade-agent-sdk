import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { runProcess } from '../createBladeAgent.js';

afterEach(() => {
  spawnMock.mockReset();
});

function fakeChild(): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  child.kill = vi.fn(() => true);
  return child;
}

describe('runProcess', () => {
  it('forwards termination signals and removes handlers after the child exits', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const before = process.listenerCount('SIGTERM');
    const pending = runProcess('pnpm', ['run', 'start'], { cwd: '/tmp/project' });

    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    process.emit('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    child.emit('exit', null, 'SIGTERM');
    await expect(pending).rejects.toThrow('signal SIGTERM');
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('resolves only after a successful child exit', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const pending = runProcess('pnpm', ['install'], { cwd: '/tmp/project' });

    child.emit('exit', 0, null);
    await expect(pending).resolves.toBeUndefined();
  });
});
