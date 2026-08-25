import { describe, expect, it, vi } from 'vitest';
import { PermissionRequestId, SessionId } from '../../types/branded.js';
import { RemoteApprovalBroker } from '../RemoteApprovalBroker.js';

describe('RemoteApprovalBroker', () => {
  it('correlates a durable permission request with a remote decision', async () => {
    const publish = vi.fn(async () => {});
    const broker = new RemoteApprovalBroker({ publish, timeoutMs: 1000 });
    const sessionId = SessionId('session-1');
    const requestId = PermissionRequestId('permission-1');
    const pending = broker.createHandler('tenant-a', sessionId).requestConfirmation({
      permissionRequestId: requestId,
      toolName: 'Write',
      args: { file_path: 'README.md' },
      message: 'Allow write?',
      affectedFiles: ['README.md'],
    });

    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    broker.resolve('tenant-a', sessionId, requestId, {
      approved: true,
      scope: 'session',
    });
    await expect(pending).resolves.toEqual({
      approved: true,
      scope: 'session',
    });
  });

  it('does not allow a different tenant to resolve an approval', async () => {
    const broker = new RemoteApprovalBroker({
      publish: async () => {},
      timeoutMs: 1000,
    });
    const sessionId = SessionId('session-1');
    const requestId = PermissionRequestId('permission-1');
    const pending = broker.createHandler('tenant-a', sessionId).requestConfirmation({
      permissionRequestId: requestId,
      message: 'Allow?',
    });

    expect(() => broker.resolve('tenant-b', sessionId, requestId, {
      approved: true,
    })).toThrow(/not pending/i);
    broker.cancelSession('tenant-a', sessionId, new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
  });

  it('cancels pending approvals when their request aborts', async () => {
    const broker = new RemoteApprovalBroker({
      publish: async () => {},
      timeoutMs: 1000,
    });
    const controller = new AbortController();
    const pending = broker.createHandler('tenant-a', SessionId('session-1'))
      .requestConfirmation({
        message: 'Allow?',
        abortSignal: controller.signal,
      });
    controller.abort(new Error('request aborted'));
    await expect(pending).rejects.toThrow('request aborted');
  });

  it('expires unresolved approvals', async () => {
    const broker = new RemoteApprovalBroker({
      publish: async () => {},
      timeoutMs: 5,
    });
    const pending = broker.createHandler('tenant-a', SessionId('session-1'))
      .requestConfirmation({ message: 'Allow?' });

    await expect(pending).rejects.toMatchObject({
      protocolCode: 'PERMISSION_NOT_FOUND',
      status: 408,
    });
  });

  it('removes pending state when publishing the approval fails', async () => {
    const sessionId = SessionId('session-1');
    const requestId = PermissionRequestId('permission-1');
    const broker = new RemoteApprovalBroker({
      publish: async () => {
        throw new Error('event store unavailable');
      },
      timeoutMs: 1000,
    });
    const pending = broker.createHandler('tenant-a', sessionId)
      .requestConfirmation({
        permissionRequestId: requestId,
        message: 'Allow?',
      });

    await expect(pending).rejects.toThrow('event store unavailable');
    expect(() => broker.resolve('tenant-a', sessionId, requestId, {
      approved: true,
    })).toThrow(/not pending/i);
  });
});
