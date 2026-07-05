import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const projectionModulePath = '../../packages/agent-sdk/src/session/kernelStreamProjection.js';
const projectionSourcePath = 'packages/agent-sdk/src/session/kernelStreamProjection.ts';

describe('agent-sdk kernel stream projection', () => {
  it('projects agent kernel events into session stream messages without runtime state', async () => {
    expect(existsSync(projectionSourcePath)).toBe(true);

    const { projectPackageLocalKernelEventToStreamMessages } = await import(projectionModulePath);

    expect(
      projectPackageLocalKernelEventToStreamMessages(
        { type: 'content', delta: 'hello' },
        { sessionId: 'session-1', maxContextTokens: 4096, includeThinking: false },
      ),
    ).toEqual([{ type: 'content', delta: 'hello', sessionId: 'session-1' }]);

    expect(
      projectPackageLocalKernelEventToStreamMessages(
        { type: 'thinking', delta: 'hidden' },
        { sessionId: 'session-1', maxContextTokens: 4096, includeThinking: false },
      ),
    ).toEqual([]);

    expect(
      projectPackageLocalKernelEventToStreamMessages(
        { type: 'thinking', delta: 'visible' },
        { sessionId: 'session-1', maxContextTokens: 4096, includeThinking: true },
      ),
    ).toEqual([{ type: 'thinking', delta: 'visible', sessionId: 'session-1' }]);

    expect(
      projectPackageLocalKernelEventToStreamMessages(
        {
          type: 'tool_permission_updates',
          toolCall: {
            id: 'call-1',
            name: 'Edit',
            input: {},
          },
          updates: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [{ toolName: 'Edit', ruleContent: '/workspace/file.ts' }],
            },
            {
              type: 'removeRules',
              rules: [{ toolName: 'Bash' }],
            },
          ],
        },
        { sessionId: 'session-1', maxContextTokens: 4096, includeThinking: false },
      ),
    ).toEqual([
      {
        type: 'tool_permission_updates',
        id: 'call-1',
        name: 'Edit',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'Edit', ruleContent: '/workspace/file.ts' }],
          },
          {
            type: 'removeRules',
            rules: [{ toolName: 'Bash' }],
          },
        ],
        sessionId: 'session-1',
      },
    ]);

    expect(
      projectPackageLocalKernelEventToStreamMessages(
        {
          type: 'usage',
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            reasoningTokens: 2,
            cacheReadInputTokens: 3,
            cacheMissInputTokens: 4,
            billableInputTokens: 11,
          },
        },
        { sessionId: 'session-1', maxContextTokens: 4096, includeThinking: false },
      ),
    ).toEqual([
      {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          maxContextTokens: 4096,
          reasoningTokens: 2,
          cacheReadInputTokens: 3,
          cacheMissInputTokens: 4,
          billableInputTokens: 11,
        },
        sessionId: 'session-1',
      },
    ]);

    expect(
      projectPackageLocalKernelEventToStreamMessages(
        { type: 'result', content: 'done' },
        { sessionId: 'session-1', maxContextTokens: 4096, includeThinking: false },
      ),
    ).toEqual([
      { type: 'turn_end', turn: 1, sessionId: 'session-1' },
      { type: 'result', subtype: 'success', content: 'done', sessionId: 'session-1' },
    ]);
  });
});
