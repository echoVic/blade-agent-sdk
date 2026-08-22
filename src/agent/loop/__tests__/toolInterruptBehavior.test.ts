import { describe, expect, it } from 'vitest';
import { ActiveRequestController } from '../../../session/ActiveRequestController.js';
import { InputId, RequestId } from '../../../types/branded.js';
import { createInterruptAwareAbortSignal } from '../toolInterruptBehavior.js';

describe('createInterruptAwareAbortSignal', () => {
  it('propagates steering interrupts only to cancel tools', () => {
    const runControl = new ActiveRequestController(RequestId('request-1'));
    const cancelTool = createInterruptAwareAbortSignal({
      requestSignal: runControl.requestSignal,
      steeringSignal: runControl.steeringSignal,
      interruptBehavior: 'cancel',
    });
    const blockTool = createInterruptAwareAbortSignal({
      requestSignal: runControl.requestSignal,
      steeringSignal: runControl.steeringSignal,
      interruptBehavior: 'block',
    });

    runControl.interruptStep(InputId('input-1'));

    expect(cancelTool.signal.aborted).toBe(true);
    expect(blockTool.signal.aborted).toBe(false);
    cancelTool.cleanup();
    blockTool.cleanup();
  });

  it('always propagates request aborts to block tools', () => {
    const runControl = new ActiveRequestController(RequestId('request-1'));
    const blockTool = createInterruptAwareAbortSignal({
      requestSignal: runControl.requestSignal,
      steeringSignal: runControl.steeringSignal,
      interruptBehavior: 'block',
    });

    runControl.abortRequest({ kind: 'user_abort' });

    expect(blockTool.signal.aborted).toBe(true);
    expect(blockTool.signal.reason).toEqual({ kind: 'user_abort' });
    blockTool.cleanup();
  });
});
