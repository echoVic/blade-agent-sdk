import { describe, expect, it } from 'vitest';
import { buildAgentToolResultContent } from '../loop/toolResultContent.js';

describe('agent tool result content projection', () => {
  it('uses successful string llm content as the tool message content', () => {
    expect(buildAgentToolResultContent({ success: true, llmContent: 'ok' })).toBe('ok');
  });

  it('serializes successful object llm content as formatted JSON', () => {
    expect(
      buildAgentToolResultContent({
        success: true,
        llmContent: { status: 'ok', count: 2 },
      }),
    ).toBe('{\n  "status": "ok",\n  "count": 2\n}');
  });

  it('uses failure messages and falls back to the stable failure text', () => {
    expect(
      buildAgentToolResultContent({
        success: false,
        error: { message: 'permission denied' },
      }),
    ).toBe('permission denied');
    expect(buildAgentToolResultContent({ success: false })).toBe('执行失败');
  });
});
