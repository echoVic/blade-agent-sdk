import { describe, expect, it } from 'vitest';
import { SessionId } from '../local/branded.js';
import { getEffectiveProjectDir } from '../tools/types/ExecutionTypes.js';
import type { ExecutionContext, ExecutionHistoryEntry } from '../tools/types/ExecutionTypes.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSnapshot: any = {
  cwd: '/home/user/project',
  sessionId: SessionId('s1'),
  turnId: 't1',
  context: {},
  filesystemRoots: [],
  environment: {},
};

describe('ExecutionTypes (agent-sdk)', () => {
  it('exports getEffectiveProjectDir utility', () => {
    const ctx: ExecutionContext = {
      contextSnapshot: mockSnapshot,
    };
    const dir = getEffectiveProjectDir(ctx);
    expect(dir).toBe('/home/user/project');
  });

  it('returns undefined when no cwd in context', () => {
    const ctx: ExecutionContext = {};
    const dir = getEffectiveProjectDir(ctx);
    expect(dir).toBeUndefined();
  });

  it('type-checks ExecutionHistoryEntry shape', () => {
    const entry: ExecutionHistoryEntry = {
      executionId: 'exec-1',
      toolName: 'test',
      params: { key: 'value' },
      result: { success: true, llmContent: 'ok' },
      startTime: 0,
      endTime: 100,
      context: { sessionId: SessionId('session-1') as any },
    };
    expect(entry.executionId).toBe('exec-1');
  });
});
