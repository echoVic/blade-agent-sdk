import { describe, expect, it } from 'vitest';
import { buildAgentLoopToolMessage } from '../loop/toolMessage.js';

describe('agent loop tool message projection', () => {
  it('builds a tool message from successful tool llm content', () => {
    expect(buildAgentLoopToolMessage({
      toolCall: {
        id: 'call_read',
        type: 'function',
        function: { name: 'Read', arguments: '{"file":"README.md"}' },
      },
      result: {
        success: true,
        llmContent: { ok: true, lines: 12 },
      },
    })).toEqual({
      role: 'tool',
      tool_call_id: 'call_read',
      name: 'Read',
      content: '{\n  "ok": true,\n  "lines": 12\n}',
    });
  });

  it('uses the stable failure content for failed tool results', () => {
    expect(buildAgentLoopToolMessage({
      toolCall: {
        id: 'call_write',
        type: 'function',
        function: { name: 'Write', arguments: '{}' },
      },
      result: {
        success: false,
        error: { message: 'permission denied' },
      },
    })).toEqual({
      role: 'tool',
      tool_call_id: 'call_write',
      name: 'Write',
      content: 'permission denied',
    });
  });
});
