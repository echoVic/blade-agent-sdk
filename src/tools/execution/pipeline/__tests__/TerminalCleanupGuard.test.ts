import { describe, expect, it, vi } from 'vitest';
import { DurableExecutionLeaseError } from '../../../../session/events/DurableExecutionLeaseStore.js';
import { isTerminalCleanupFailure, TerminalCleanupGuard } from '../TerminalCleanupGuard.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function leaseFailure(): DurableExecutionLeaseError {
  return new DurableExecutionLeaseError('DURABLE_EXECUTION_LEASE_LOST', 'lease lost');
}

describe('TerminalCleanupGuard', () => {
  it('treats execution-lease failures as terminal', () => {
    expect(isTerminalCleanupFailure(leaseFailure())).toBe(true);
    expect(isTerminalCleanupFailure(new Error('ordinary failure'))).toBe(false);
    expect(isTerminalCleanupFailure(undefined)).toBe(false);
  });

  it('keeps the first terminal failure and refuses later work', () => {
    const guard = new TerminalCleanupGuard();
    const first = leaseFailure();
    const second = leaseFailure();

    guard.remember(new Error('ordinary failure'));
    expect(guard.getTerminalFailure()).toBeUndefined();
    expect(() => guard.throwIfFailed()).not.toThrow();

    guard.remember(first);
    guard.remember(second);
    expect(guard.getTerminalFailure()).toBe(first);
    expect(() => guard.throwIfFailed()).toThrow(first);
  });

  it('labels a pending refusal by the work that is still cleaning up', () => {
    const guard = new TerminalCleanupGuard();
    expect(guard.createPendingResult().error?.message).toContain('A tool execution');

    const controller = new AbortController();
    const pending = deferred();
    const callback = guard.awaitPermissionCallback(() => pending.promise, controller.signal);
    controller.abort(new Error('cancelled'));
    return callback
      .catch(() => undefined)
      .then(() => {
        expect(guard.hasPendingPermissionCleanup()).toBe(true);
        expect(guard.createPendingResult().error?.message).toContain('A permission callback');
      });
  });

  it('quarantines the guard when a cancelled callback rejects later', async () => {
    const guard = new TerminalCleanupGuard();
    const controller = new AbortController();
    const pending = deferred();

    const callback = guard.awaitPermissionCallback(() => pending.promise, controller.signal);
    const settled = expect(callback).rejects.toThrow('cancelled');
    controller.abort(new Error('cancelled'));
    await settled;

    pending.reject(leaseFailure());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(guard.getTerminalFailure()).toBeInstanceOf(DurableExecutionLeaseError);
  });

  it('does not quarantine a callback that only fails with an ordinary error', async () => {
    const guard = new TerminalCleanupGuard();
    const controller = new AbortController();
    const pending = deferred();

    const callback = guard.awaitPermissionCallback(() => pending.promise, controller.signal);
    const settled = expect(callback).rejects.toThrow('cancelled');
    controller.abort(new Error('cancelled'));
    await settled;

    pending.reject(new Error('ordinary failure'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(guard.getTerminalFailure()).toBeUndefined();
  });

  it('reports pending execution cleanup until the closing generator settles', async () => {
    const guard = new TerminalCleanupGuard();
    const closing = deferred();
    const tracked = closing.promise.then(() => undefined);

    guard.trackExecutionCleanup(tracked);
    expect(guard.hasPendingExecutionCleanup()).toBe(true);

    closing.resolve();
    await tracked;
    expect(guard.hasPendingExecutionCleanup()).toBe(false);
  });

  it('quarantines the guard when a tracked cleanup fails terminally', async () => {
    const guard = new TerminalCleanupGuard();
    const tracked = Promise.reject(leaseFailure());
    guard.trackExecutionCleanup(tracked);
    await vi.waitFor(() => {
      expect(guard.getTerminalFailure()).toBeInstanceOf(DurableExecutionLeaseError);
      expect(guard.hasPendingExecutionCleanup()).toBe(false);
    });
  });
});
