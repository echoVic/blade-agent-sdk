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

  it('accepts sandbox capabilities in tool context patches', () => {
    const event = {
      type: 'tool_context_patch',
      sessionId: 'session-1',
      id: 'tool-1',
      name: 'ConfigureSandbox',
      patch: {
        scope: 'turn',
        context: {
          capabilities: {
            sandbox: {
              enabled: true,
              autoAllowBashIfSandboxed: true,
              excludedCommands: ['ssh'],
              allowUnsandboxedCommands: false,
              network: {
                allowLocalBinding: false,
                allowUnixSockets: ['/tmp/agent.sock'],
                allowAllUnixSockets: false,
                httpProxyPort: 8080,
                socksProxyPort: 1080,
              },
              ignoreViolations: {
                file: ['/tmp/cache'],
                network: ['registry.example.com'],
              },
              enableWeakerNestedSandbox: true,
            },
          },
        },
      },
    };

    expect(parseSessionStreamEvent(event)).toEqual(event);
  });
});
