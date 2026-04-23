import { describe, expect, it } from 'vitest';
import { createContextSnapshot } from '../../../../runtime/index.js';
import { SessionId } from '../../../../types/branded.js';
import { readTool } from '../read.js';

describe('file tools runtime context', () => {
  it('should return a friendly error when filesystem capability is unavailable', async () => {
    const invocation = readTool.build({
      file_path: '/tmp/example.txt',
      encoding: 'utf8',
    });
    const result = await invocation.execute(
      new AbortController().signal,
      undefined,
      {
        contextSnapshot: createContextSnapshot(SessionId('session-1'), 'turn-1', {}),
      },
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('No filesystem access in current context');
  });
});
