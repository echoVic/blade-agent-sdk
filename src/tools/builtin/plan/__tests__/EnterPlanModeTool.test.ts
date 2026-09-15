import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '../../../types/execution.js';
import { collectToolExecution } from '../../../types/result.js';
import { enterPlanModeTool } from '../EnterPlanModeTool.js';

describe('EnterPlanMode Tool', () => {
  it('passes the active tool signal to the confirmation handler', async () => {
    const controller = new AbortController();
    const requestConfirmation = vi.fn(async () => ({ approved: true }));

    const result = await collectToolExecution(
      enterPlanModeTool.execute({}, {
        signal: controller.signal,
        confirmationHandler: { requestConfirmation },
      } satisfies ExecutionContext),
    );

    expect(requestConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'enterPlanMode',
        abortSignal: controller.signal,
      }),
    );
    expect(result.status).toBe('success');
  });
});
