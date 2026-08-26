import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_PROTOCOL_VERSION,
  AgentCommandType,
  type AgentServerEvent,
} from '../../protocol/index.js';
import { EventId, EventSequence, SessionId } from '../../types/identifiers.js';
import { AgentClient } from '../AgentClient.js';

const sessionId = SessionId('session-1');

function initializeResponse(commandId: string): Response {
  return Response.json({
    protocolVersion: AGENT_PROTOCOL_VERSION,
    commandId,
    ok: true,
    data: {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      commands: Object.values(AgentCommandType),
      transports: ['http-sse'],
      serverTime: '2026-08-25T00:00:00.000Z',
      features: {
        approvals: true,
        durableEvents: true,
        eventReplay: true,
        idempotentCommands: true,
      },
    },
  });
}

function event(
  sequence: number,
  type: AgentServerEvent['type'],
  data: AgentServerEvent['data'],
): AgentServerEvent {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    eventId: `event-${sequence}`,
    sequence,
    sessionId,
    occurredAt: '2026-08-25T00:00:00.000Z',
    type,
    data,
  } as AgentServerEvent;
}

function sseResponse(value = ''): Response {
  return new Response(value, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('AgentClient events', () => {
  it('reconnects from the last cursor and parses CRLF event frames', async () => {
    const eventRequests: Request[] = [];
    const responses = [
      sseResponse(
        `id: 1\r\nevent: session.stream\r\ndata: ${JSON.stringify(
          event(1, 'session.stream', { type: 'content', delta: 'first', sessionId }),
        )}\r\n\r\n`,
      ),
      sseResponse(
        `id: 2\nevent: session.closed\ndata: ${JSON.stringify(
          event(2, 'session.closed', { reason: 'test' }),
        )}\n\n`,
      ),
    ];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'POST') {
        const body = (await request.json()) as { commandId: string };
        return initializeResponse(body.commandId);
      }
      eventRequests.push(request);
      return responses.shift() ?? sseResponse();
    });
    const client = new AgentClient({
      baseUrl: 'https://agent.test/v1/agent',
      client: { name: 'test-client', version: '1.0.0' },
      fetch: fetchImpl,
      maxEventReconnectAttempts: 1,
      retryBaseDelayMs: 0,
    });

    const received: AgentServerEvent[] = [];
    for await (const serverEvent of client.events(sessionId)) {
      received.push(serverEvent);
    }

    expect(received.map((serverEvent) => serverEvent.sequence)).toEqual([1, 2]);
    expect(eventRequests).toHaveLength(2);
    expect(new URL(eventRequests[0]?.url ?? '').searchParams.get('after')).toBe('0');
    expect(new URL(eventRequests[1]?.url ?? '').searchParams.get('after')).toBe('1');
    expect(eventRequests[1]?.headers.get('last-event-id')).toBe('1');
  });

  it('stops after the configured number of clean disconnects', async () => {
    let eventRequests = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'POST') {
        const body = (await request.json()) as { commandId: string };
        return initializeResponse(body.commandId);
      }
      eventRequests += 1;
      return sseResponse();
    });
    const client = new AgentClient({
      baseUrl: 'https://agent.test/v1/agent',
      client: { name: 'test-client', version: '1.0.0' },
      fetch: fetchImpl,
      maxEventReconnectAttempts: 2,
      retryBaseDelayMs: 0,
    });

    const iterator = client.events(sessionId);
    await expect(iterator.next()).rejects.toMatchObject({
      protocolCode: 'INTERNAL_ERROR',
      retryable: true,
    });
    expect(eventRequests).toBe(3);
  });

  it('does not retry a stale event cursor', async () => {
    let eventRequests = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'POST') {
        const body = (await request.json()) as { commandId: string };
        return initializeResponse(body.commandId);
      }
      eventRequests += 1;
      return Response.json(
        {
          protocolVersion: AGENT_PROTOCOL_VERSION,
          commandId: 'events',
          ok: false,
          error: {
            code: 'STALE_CURSOR',
            message: 'Event cursor is stale',
            retryable: false,
          },
        },
        { status: 409 },
      );
    });
    const client = new AgentClient({
      baseUrl: 'https://agent.test/v1/agent',
      client: { name: 'test-client', version: '1.0.0' },
      fetch: fetchImpl,
      maxEventReconnectAttempts: 5,
      retryBaseDelayMs: 0,
    });

    const iterator = client.events(sessionId);
    await expect(iterator.next()).rejects.toMatchObject({
      protocolCode: 'STALE_CURSOR',
    });
    expect(eventRequests).toBe(1);
  });

  it('rejects a cursor that belongs to another Session before connecting', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new AgentClient({
      baseUrl: 'https://agent.test/v1/agent',
      client: { name: 'test-client', version: '1.0.0' },
      fetch: fetchImpl,
    });

    const iterator = client.events(sessionId, {
      after: {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        eventId: EventId('event-1'),
        sequence: EventSequence(1),
        sessionId: SessionId('session-2'),
      },
    });
    await expect(iterator.next()).rejects.toMatchObject({
      protocolCode: 'INVALID_COMMAND',
      status: 400,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed on a non-monotonic event sequence', async () => {
    const responses = [
      sseResponse(
        `data: ${JSON.stringify(
          event(1, 'session.stream', { type: 'content', delta: 'first', sessionId }),
        )}\n\n`,
      ),
      sseResponse(
        `data: ${JSON.stringify(
          event(1, 'session.stream', { type: 'content', delta: 'duplicate', sessionId }),
        )}\n\n`,
      ),
    ];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'POST') {
        const body = (await request.json()) as { commandId: string };
        return initializeResponse(body.commandId);
      }
      return responses.shift() ?? sseResponse();
    });
    const client = new AgentClient({
      baseUrl: 'https://agent.test/v1/agent',
      client: { name: 'test-client', version: '1.0.0' },
      fetch: fetchImpl,
      maxEventReconnectAttempts: 1,
      retryBaseDelayMs: 0,
    });

    const iterator = client.events(sessionId);
    await expect(iterator.next()).resolves.toMatchObject({
      value: { sequence: 1 },
      done: false,
    });
    await expect(iterator.next()).rejects.toMatchObject({
      protocolCode: 'INVALID_COMMAND',
      status: 502,
    });
  });
});

describe('AgentClient commands', () => {
  it('calls fetch without binding the AgentClient instance as its receiver', async () => {
    let receiver: unknown = 'not-called';
    const fetchImpl = function (
      this: unknown,
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> {
      receiver = this;
      const request = new Request(input, init);
      return request.json().then((body) =>
        initializeResponse((body as { commandId: string }).commandId));
    };
    const client = new AgentClient({
      baseUrl: 'https://agent.test/v1/agent',
      client: { name: 'test-client', version: '1.0.0' },
      fetch: fetchImpl,
    });

    await client.initialize();

    expect(receiver).toBeUndefined();
  });

  it('retries a non-JSON HTTP 429 with the same command ID', async () => {
    const commandIds: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const body = (await request.json()) as { commandId: string };
      commandIds.push(body.commandId);
      if (commandIds.length === 1) {
        return new Response('rate limited', {
          status: 429,
          headers: { 'retry-after': '0' },
        });
      }
      return initializeResponse(body.commandId);
    });
    const client = new AgentClient({
      baseUrl: 'https://agent.test/v1/agent',
      client: { name: 'test-client', version: '1.0.0' },
      fetch: fetchImpl,
      maxCommandAttempts: 2,
      retryBaseDelayMs: 0,
    });

    await expect(client.initialize()).resolves.toMatchObject({
      protocolVersion: AGENT_PROTOCOL_VERSION,
    });
    expect(commandIds).toHaveLength(2);
    expect(commandIds[1]).toBe(commandIds[0]);
  });
});
