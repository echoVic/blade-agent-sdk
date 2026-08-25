import { describe, expect, it } from 'vitest';
import type { ModelToolCall } from '../../../model/message.js';
import { PermissionMode } from '../../../types/constants.js';
import { planToolExecution } from '../planToolExecution.js';

const makeCall = (name: string, args: Record<string, unknown> = {}): ModelToolCall => ({
  id: `${name}-call`,
  type: 'function',
  function: {
    name,
    arguments: JSON.stringify(args),
  },
});

describe('planToolExecution', () => {
  it('returns serial mode for a single call', () => {
    const plan = planToolExecution([makeCall('Read')]);

    expect(plan.mode).toBe('serial');
    expect(plan.calls.map((call) => call.function.name)).toEqual(['Read']);
  });

  it('returns serial mode in plan permission mode', () => {
    const plan = planToolExecution([makeCall('Read'), makeCall('Glob')], PermissionMode.PLAN);

    expect(plan.mode).toBe('serial');
    expect(plan.calls.map((call) => call.function.name)).toEqual(['Read', 'Glob']);
  });

  it('returns parallel mode for an empty call list', () => {
    const plan = planToolExecution([]);

    expect(plan.mode).toBe('parallel');
    expect(plan.calls).toEqual([]);
  });

  it('delegates concurrency limits for ordinary calls without reordering them', () => {
    const plan = planToolExecution([
      makeCall('Edit'),
      makeCall('Read'),
      makeCall('Unknown'),
      makeCall('Bash', { command: 'npm install' }),
    ]);

    expect(plan.mode).toBe('parallel');
    expect(plan.calls.map((call) => call.function.name)).toEqual([
      'Edit',
      'Read',
      'Unknown',
      'Bash',
    ]);
  });
});
