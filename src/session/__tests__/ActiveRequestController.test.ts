import { describe, expect, it } from 'vitest';
import { InputId, RequestId } from '../../types/branded.js';
import { ActiveRequestController } from '../ActiveRequestController.js';

describe('ActiveRequestController', () => {
  it('interrupts a step without aborting the request', () => {
    const controller = new ActiveRequestController(RequestId('request-1'));
    const firstStepSignal = controller.stepSignal;

    controller.interruptStep({
      kind: 'steering',
      inputId: InputId('input-1'),
    });

    expect(firstStepSignal.aborted).toBe(true);
    expect(firstStepSignal.reason).toEqual({
      kind: 'steering',
      inputId: 'input-1',
    });
    expect(controller.requestSignal.aborted).toBe(false);

    controller.advanceStep();
    expect(controller.stepSignal.aborted).toBe(false);
  });

  it('propagates request aborts to the active step', () => {
    const controller = new ActiveRequestController(RequestId('request-1'));
    const stepSignal = controller.stepSignal;

    controller.abortRequest({ kind: 'user_abort' });

    expect(controller.requestSignal.aborted).toBe(true);
    expect(controller.requestSignal.reason).toEqual({ kind: 'user_abort' });
    expect(stepSignal.aborted).toBe(true);
  });

  it('links and cleans up an external abort signal', () => {
    const external = new AbortController();
    const controller = new ActiveRequestController(
      RequestId('request-1'),
      external.signal,
    );

    external.abort('upstream');

    expect(controller.requestSignal.aborted).toBe(true);
    expect(controller.requestSignal.reason).toEqual({
      kind: 'external_abort',
      cause: 'upstream',
    });
    controller.dispose();
  });
});
