import { describe, expect, it, vi } from 'vitest';
import { createContextSnapshot } from '../../../runtime/index.js';
import { executeToolCalls } from '../executeToolCalls.js';

describe('executeToolCalls', () => {
  it('should forward the turn-scoped context snapshot into tool execution', async () => {
    const execute = vi.fn(async () => ({
      success: true,
      llmContent: 'ok',
      displayContent: 'ok',
    }));

    await executeToolCalls({
      plan: {
        mode: 'serial',
        calls: [
          {
            id: 'tool-1',
            type: 'function',
            function: {
              name: 'Read',
              arguments: JSON.stringify({ file_path: '/tmp/file.txt' }),
            },
          },
        ],
      },
      executionPipeline: {
        execute,
      } as never,
      executionContext: {
        sessionId: 'session-1',
        userId: 'user-1',
        contextSnapshot: createContextSnapshot('session-1', 'turn-1', {
          capabilities: {
            filesystem: {
              roots: ['/snapshot-root'],
              cwd: '/snapshot-root',
            },
          },
        }),
      },
    });

    expect(execute).toHaveBeenCalledWith(
      'Read',
      { file_path: '/tmp/file.txt' },
      expect.objectContaining({
        contextSnapshot: expect.objectContaining({
          cwd: '/snapshot-root',
          filesystemRoots: ['/snapshot-root'],
        }),
      }),
    );
  });
});
