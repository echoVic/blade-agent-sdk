import { describe, expect, it } from 'vitest';
import { parseSessionStreamEvent } from '../streamSchema.js';

function toolMessageEvent(messageFields: Record<string, unknown>) {
  return {
    type: 'tool_new_messages',
    sessionId: 'session-1',
    id: 'tool-1',
    name: 'Inject',
    messages: [
      {
        role: 'system',
        content: 'Injected context',
        ...messageFields,
      },
    ],
  };
}

describe('parseSessionStreamEvent', () => {
  it('accepts typed conversation fields on model messages', () => {
    expect(
      parseSessionStreamEvent(
        toolMessageEvent({
          provenance: { source: 'tool_injection' },
          extensions: { source: 'application' },
        }),
      ),
    ).toMatchObject({
      messages: [
        {
          provenance: { source: 'tool_injection' },
          extensions: { source: 'application' },
        },
      ],
    });
  });

  it('rejects the legacy untyped metadata bag', () => {
    expect(() =>
      parseSessionStreamEvent(toolMessageEvent({ metadata: { source: 'tool' } })),
    ).toThrow();
  });
});
