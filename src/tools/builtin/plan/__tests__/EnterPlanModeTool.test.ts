import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '../../../types/ExecutionTypes.js';
import { collectToolExecution } from '../../../types/ToolResult.js';
import { enterPlanModeTool } from '../EnterPlanModeTool.js';

describe('EnterPlanMode Tool', () => {
  it('passes the active tool signal to the confirmation handler', async () => {
    const controller = new AbortController();
    const requestConfirmation = vi.fn(async () => ({ approved: true }));
    const invocation = enterPlanModeTool.build({});

    const result = await collectToolExecution(
      invocation.execute(controller.signal, {
        signal: controller.signal,
        confirmationHandler: { requestConfirmation },
      } satisfies Partial<ExecutionContext>),
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
