import { describe, expect, it } from 'vitest';
import { isPlanApprovalResult } from '../local/agentLoopTypes.js';
import type { LoopResult, PlanApprovalResult } from '../local/agentLoopTypes.js';

describe('agentLoopTypes (agent-sdk)', () => {
  it('identifies a PlanApprovalResult', () => {
    const result: LoopResult = {
      success: true,
      metadata: {
        turnsCount: 1,
        toolCallsCount: 0,
        duration: 100,
        targetMode: 'plan' as any,
        planContent: 'A detailed plan',
      },
    };
    expect(isPlanApprovalResult(result)).toBe(true);
    if (isPlanApprovalResult(result)) {
      expect(result.metadata.targetMode).toBe('plan');
    }
  });

  it('returns false for undefined', () => {
    expect(isPlanApprovalResult(undefined)).toBe(false);
  });

  it('returns false for result without targetMode', () => {
    const result: LoopResult = {
      success: true,
      metadata: {
        turnsCount: 1,
        toolCallsCount: 0,
        duration: 100,
      },
    };
    expect(isPlanApprovalResult(result)).toBe(false);
  });

  it('returns false for result without metadata', () => {
    const result: LoopResult = {
      success: true,
    };
    expect(isPlanApprovalResult(result)).toBe(false);
  });
});
