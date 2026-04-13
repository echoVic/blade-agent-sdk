import { describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '../../../types/common.js';

vi.mock('nanoid', () => ({
  nanoid: () => 'generated-subagent-id',
}));

import { repairToolCallParams } from '../repairToolCallParams.js';

describe('repairToolCallParams', () => {
  it('adds a generated subagent_session_id for Task calls when missing', async () => {
    const params: JsonObject = {};

    await repairToolCallParams(
      {
        id: 'task-1',
        type: 'function',
        function: {
          name: 'Task',
          arguments: '{}',
        },
      },
      params,
    );

    expect(params.subagent_session_id).toBe('generated-subagent-id');
  });

  it('uses the resume id for Task calls when present', async () => {
    const params: JsonObject = {
      resume: 'existing-session',
    };

    await repairToolCallParams(
      {
        id: 'task-1',
        type: 'function',
        function: {
          name: 'Task',
          arguments: '{"resume":"existing-session"}',
        },
      },
      params,
    );

    expect(params.subagent_session_id).toBe('existing-session');
  });

  it('parses todos when they are encoded as a JSON string', async () => {
    const params: JsonObject = {
      todos: JSON.stringify([
        { id: 'todo-1', content: 'write tests', status: 'in_progress' },
      ]),
    };

    await repairToolCallParams(
      {
        id: 'todo-1',
        type: 'function',
        function: {
          name: 'TodoWrite',
          arguments: '{}',
        },
      },
      params,
    );

    expect(params.todos).toEqual([
      { id: 'todo-1', content: 'write tests', status: 'in_progress' },
    ]);
  });
});
