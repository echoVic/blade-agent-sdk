import { describe, expect, it } from 'vitest';
import { InputId, RequestId } from '../../types/branded.js';
import {
  SessionInputInbox,
} from '../SessionInputInbox.js';
import {
  InputPriority,
  type PendingSessionInput,
} from '../types.js';

function input(
  id: string,
  priority: PendingSessionInput['priority'],
  targetRequestId?: string,
): PendingSessionInput {
  return {
    inputId: InputId(id),
    content: id,
    priority,
    targetRequestId: targetRequestId
      ? RequestId(targetRequestId)
      : undefined,
    acceptedAt: Number(id.replace(/\D/g, '')) || 0,
  };
}

describe('SessionInputInbox', () => {
  it('orders request inputs by priority and FIFO within a priority', () => {
    const inbox = new SessionInputInbox();
    const requestId = RequestId('request-1');
    inbox.enqueue(input('input-2', InputPriority.NEXT, requestId));
    inbox.enqueue(input('input-3', InputPriority.NOW, requestId));
    inbox.enqueue(input('input-1', InputPriority.NOW, requestId));

    expect(
      inbox.claimForRequest(requestId, [
        InputPriority.NOW,
        InputPriority.NEXT,
      ]).map((entry) => entry.inputId),
    ).toEqual(['input-1', 'input-3', 'input-2']);
    expect(inbox.size).toBe(3);
    inbox.acknowledge(InputId('input-1'));
    inbox.acknowledge(InputId('input-3'));
    inbox.acknowledge(InputId('input-2'));
    expect(inbox.size).toBe(0);
  });

  it('claims later input without removing it before application', () => {
    const inbox = new SessionInputInbox();
    inbox.enqueue(input('input-1', InputPriority.LATER));

    const claimed = inbox.claimNextLater(RequestId('request-1'));

    expect(claimed?.targetRequestId).toBe('request-1');
    expect(inbox.size).toBe(1);
    expect(inbox.remove(InputId('input-1'))).toEqual(claimed);
    expect(inbox.size).toBe(0);
  });

  it('demotes restored and abandoned request inputs to later delivery', () => {
    const inbox = new SessionInputInbox();
    inbox.restore([
      input('input-1', InputPriority.NOW, 'request-dead'),
    ]);
    inbox.enqueue(input('input-2', InputPriority.NEXT, 'request-live'));

    inbox.releaseRequest(RequestId('request-live'));

    expect(inbox.getAll()).toEqual([
      expect.objectContaining({
        inputId: 'input-1',
        priority: InputPriority.LATER,
        targetRequestId: undefined,
      }),
      expect.objectContaining({
        inputId: 'input-2',
        priority: InputPriority.LATER,
        targetRequestId: undefined,
      }),
    ]);
  });

  it('enforces count and byte limits without retaining rejected input', () => {
    const byCount = new SessionInputInbox(1, 100);
    byCount.enqueue(input('input-1', InputPriority.LATER));
    expect(() => byCount.enqueue(input('input-2', InputPriority.LATER)))
      .toThrowError(expect.objectContaining({
        code: 'SESSION_INPUT_QUEUE_FULL',
      }));
    expect(byCount.size).toBe(1);

    const byBytes = new SessionInputInbox(10, 4);
    expect(() => byBytes.enqueue(input('input-12345', InputPriority.LATER)))
      .toThrowError(expect.objectContaining({
        code: 'SESSION_INPUT_QUEUE_FULL',
      }));
    expect(byBytes.size).toBe(0);
  });
});
