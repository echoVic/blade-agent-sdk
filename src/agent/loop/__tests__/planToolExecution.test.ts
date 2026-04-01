import { describe, expect, it } from 'vitest';
import { PermissionMode } from '../../../types/common.js';
import { planToolExecution } from '../planToolExecution.js';
import type { FunctionToolCall } from '../types.js';

const makeCall = (name: string): FunctionToolCall => ({
  id: `${name}-call`,
  type: 'function',
  function: {
    name,
    arguments: '{}',
  },
});

const toolKinds = new Map<string, { kind?: string }>([
  ['Read', { kind: 'readonly' }],
  ['Glob', { kind: 'readonly' }],
  ['Grep', { kind: 'readonly' }],
  ['Edit', { kind: 'write' }],
  ['Write', { kind: 'write' }],
  ['Bash', { kind: 'execute' }],
]);

const mockRegistry = {
  get(name: string): { kind?: string } | undefined {
    return toolKinds.get(name);
  },
};

describe('planToolExecution', () => {
  it('returns serial mode for a single call', () => {
    const plan = planToolExecution([makeCall('Read')], mockRegistry);

    expect(plan.mode).toBe('serial');
    expect(plan.calls.map((call) => call.function.name)).toEqual(['Read']);
    expect(plan.groups).toBeUndefined();
  });

  it('returns serial mode in plan permission mode', () => {
    const plan = planToolExecution(
      [makeCall('Read'), makeCall('Glob')],
      mockRegistry,
      PermissionMode.PLAN,
    );

    expect(plan.mode).toBe('serial');
    expect(plan.calls.map((call) => call.function.name)).toEqual(['Read', 'Glob']);
    expect(plan.groups).toBeUndefined();
  });

  it('returns parallel mode for all readonly calls', () => {
    const plan = planToolExecution(
      [makeCall('Read'), makeCall('Glob'), makeCall('Grep')],
      mockRegistry,
    );

    expect(plan.mode).toBe('parallel');
    expect(plan.calls.map((call) => call.function.name)).toEqual(['Read', 'Glob', 'Grep']);
    expect(plan.groups).toBeUndefined();
  });

  it('returns serial mode for all write calls', () => {
    const plan = planToolExecution(
      [makeCall('Edit'), makeCall('Write'), makeCall('Bash')],
      mockRegistry,
    );

    expect(plan.mode).toBe('serial');
    expect(plan.calls.map((call) => call.function.name)).toEqual(['Edit', 'Write', 'Bash']);
    expect(plan.groups).toBeUndefined();
  });

  it('returns mixed mode with readonly calls grouped first', () => {
    const plan = planToolExecution(
      [makeCall('Edit'), makeCall('Read'), makeCall('Bash'), makeCall('Glob')],
      mockRegistry,
    );

    expect(plan.mode).toBe('mixed');
    expect(plan.calls.map((call) => call.function.name)).toEqual(['Read', 'Glob', 'Edit', 'Bash']);
    expect(plan.groups?.map((group) => group.map((call) => call.function.name))).toEqual([
      ['Read', 'Glob'],
      ['Edit'],
      ['Bash'],
    ]);
  });

  it('treats unknown tools as non-readonly', () => {
    const plan = planToolExecution(
      [makeCall('Read'), makeCall('Unknown')],
      mockRegistry,
    );

    expect(plan.mode).toBe('mixed');
    expect(plan.calls.map((call) => call.function.name)).toEqual(['Read', 'Unknown']);
    expect(plan.groups?.map((group) => group.map((call) => call.function.name))).toEqual([
      ['Read'],
      ['Unknown'],
    ]);
  });
});
