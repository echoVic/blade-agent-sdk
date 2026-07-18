import { describe, expect, it } from 'vitest';
import { PlanExecutor } from '../local/planExecutor.js';

describe('PlanExecutor (agent-sdk)', () => {
  it('can be instantiated', () => {
    const executor = new PlanExecutor('en');
    expect(executor).toBeInstanceOf(PlanExecutor);
  });

  it('injects plan reminder into string messages', () => {
    const executor = new PlanExecutor('en');
    const result = executor.injectPlanReminder('What is the plan?');
    expect(typeof result).toBe('string');
    expect(result).toContain('plan');
    expect(result).toContain('What is the plan?');
  });

  it('injects plan reminder into content part messages', () => {
    const executor = new PlanExecutor('en');
    const result = executor.injectPlanReminder([
      { type: 'text' as const, text: 'Analyze the code' },
    ]);
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result[0].type).toBe('text');
    }
  });

  it('handles non-text content parts by prepending reminder', () => {
    const executor = new PlanExecutor('en');
    const result = executor.injectPlanReminder([
      { type: 'image', data: 'base64...' } as any,
    ]);
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) {
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result[0].type).toBe('text');
    }
  });
});
