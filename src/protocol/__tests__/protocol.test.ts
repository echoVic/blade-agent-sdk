import { describe, expect, it } from 'vitest';
import {
  AGENT_PROTOCOL_VERSION,
  AgentCommandType,
  parseAgentCommand,
  parseAgentCommandResult,
  parseAgentServerEvent,
} from '../index.js';

describe('agent protocol v1', () => {
  it('parses strict versioned commands', () => {
    expect(parseAgentCommand({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      commandId: 'command-1',
      type: AgentCommandType.INPUT_SUBMIT,
      data: {
        sessionId: 'session-1',
        input: [
          { type: 'text', text: 'inspect this' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AA==' },
          },
        ],
        priority: 'next',
      },
    })).toMatchObject({
      type: 'input.submit',
      data: { sessionId: 'session-1' },
    });
  });

  it.each([
    {
      protocolVersion: 2,
      commandId: 'command-1',
      type: 'session.list',
      data: {},
    },
    {
      protocolVersion: 1,
      commandId: '../unsafe',
      type: 'session.list',
      data: {},
    },
    {
      protocolVersion: 1,
      commandId: 'command-1',
      type: 'session.list',
      data: {},
      extra: true,
    },
  ])('rejects incompatible or ambiguous commands', (command) => {
    expect(() => parseAgentCommand(command)).toThrow();
  });

  it('parses success and failure responses', () => {
    expect(parseAgentCommandResult({
      protocolVersion: 1,
      commandId: 'command-1',
      ok: true,
      data: { accepted: true },
    })).toMatchObject({ ok: true });
    expect(parseAgentCommandResult({
      protocolVersion: 1,
      commandId: 'command-2',
      ok: false,
      error: {
        code: 'OVERLOADED',
        message: 'busy',
        retryable: true,
        retryAfterMs: 100,
      },
    })).toMatchObject({ ok: false });
  });

  it('parses transport events without accepting unknown envelope fields', () => {
    const event = {
      protocolVersion: 1,
      eventId: 'event-1',
      sequence: 1,
      sessionId: 'session-1',
      occurredAt: new Date().toISOString(),
      type: 'session.stream',
      data: {
        type: 'content',
        delta: 'hello',
        sessionId: 'session-1',
      },
    };
    expect(parseAgentServerEvent(event)).toMatchObject({
      eventId: 'event-1',
      sequence: 1,
    });
    expect(() => parseAgentServerEvent({ ...event, extra: true })).toThrow();
  });
});
