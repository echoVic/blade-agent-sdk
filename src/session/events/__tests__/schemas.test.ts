import { describe, expect, it } from 'vitest';
import {
  CommandId,
  EventId,
  InputId,
  PermissionRequestId,
  RequestId,
  ToolAttemptId,
  ToolUseId,
  TurnId,
} from '../../../types/branded.js';
import { parseDurableEventDraft, parseDurableEventEnvelope } from '../schemas.js';
import {
  DURABLE_EVENT_SCHEMA_VERSION,
  type DurableEventDraft,
  DurableEventType,
} from '../types.js';

const requestId = RequestId('request-1');
const commandId = CommandId('command-1');
const turnId = TurnId('turn-1');
const toolAttemptId = ToolAttemptId('attempt-1');
const toolCallId = ToolUseId('call-1');
const permissionRequestId = PermissionRequestId('permission-1');

const validDrafts: readonly DurableEventDraft[] = [
  {
    type: DurableEventType.SESSION_CREATED,
    data: { source: 'create' },
  },
  {
    type: DurableEventType.SESSION_CLOSED,
    data: { reason: 'shutdown' },
  },
  {
    type: DurableEventType.REQUEST_ACCEPTED,
    requestId,
    commandId,
    data: {
      inputId: InputId('input-1'),
      input: [{ type: 'text', text: 'hello' }],
      priority: 'next',
      maxTurns: 12,
      model: 'test-model',
      context: {
        id: 'request-context',
        environment: { REGION: 'test' },
      },
      recovery: {
        requestId: RequestId('source-request'),
        turnId: TurnId('source-turn'),
        turn: 3,
      },
    },
  },
  {
    type: DurableEventType.REQUEST_STARTED,
    requestId,
    data: {},
  },
  {
    type: DurableEventType.REQUEST_COMPLETED,
    requestId,
    data: {
      output: 'done',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    },
  },
  {
    type: DurableEventType.REQUEST_FAILED,
    requestId,
    data: {
      error: { message: 'failed', code: 'MODEL_ERROR', retryable: true },
    },
  },
  {
    type: DurableEventType.REQUEST_INTERRUPTED,
    requestId,
    data: {
      reason: 'steering',
      byInputId: InputId('input-2'),
    },
  },
  {
    type: DurableEventType.TURN_STARTED,
    requestId,
    turnId,
    data: { turn: 1, model: 'claude-sonnet' },
  },
  {
    type: DurableEventType.TURN_COMPLETED,
    requestId,
    turnId,
    data: { turn: 1, hasToolCalls: true },
  },
  {
    type: DurableEventType.TURN_ABORTED,
    requestId,
    turnId,
    data: { turn: 1, reason: 'request_interrupted' },
  },
  {
    type: DurableEventType.TOOL_SCHEDULED,
    requestId,
    turnId,
    toolAttemptId,
    data: {
      toolCallId,
      toolName: 'Write',
      input: { file_path: '/tmp/file' },
      sideEffect: 'non_idempotent',
      interruptBehavior: 'block',
    },
  },
  {
    type: DurableEventType.TOOL_STARTED,
    requestId,
    turnId,
    toolAttemptId,
    data: {
      toolCallId,
      toolName: 'Write',
      input: { file_path: '/tmp/file' },
      sideEffect: 'non_idempotent',
    },
  },
  {
    type: DurableEventType.TOOL_COMPLETED,
    requestId,
    turnId,
    toolAttemptId,
    data: { toolCallId, toolName: 'Write', result: { changed: true } },
  },
  {
    type: DurableEventType.TOOL_FAILED,
    requestId,
    turnId,
    toolAttemptId,
    data: {
      toolCallId,
      toolName: 'Write',
      error: { message: 'disk full', code: 'ENOSPC' },
    },
  },
  {
    type: DurableEventType.TOOL_CANCELLED,
    requestId,
    turnId,
    toolAttemptId,
    data: {
      toolCallId,
      toolName: 'Write',
      reason: 'request_interrupted',
    },
  },
  {
    type: DurableEventType.TOOL_OUTCOME_UNKNOWN,
    requestId,
    turnId,
    toolAttemptId,
    data: {
      toolCallId,
      toolName: 'Write',
      reason: 'process_restart',
    },
  },
  {
    type: DurableEventType.PERMISSION_REQUESTED,
    requestId,
    turnId,
    toolAttemptId,
    data: {
      permissionRequestId,
      toolCallId,
      toolName: 'Write',
      input: { file_path: '/tmp/file' },
      message: 'Allow write?',
    },
  },
  {
    type: DurableEventType.PERMISSION_RESOLVED,
    requestId,
    turnId,
    toolAttemptId,
    data: {
      permissionRequestId,
      decision: 'allow',
    },
  },
  {
    type: DurableEventType.INPUT_APPLIED,
    requestId,
    turnId,
    data: {
      inputId: InputId('input-2'),
      priority: 'now',
    },
  },
];

describe('durable event schemas', () => {
  it('parses every durable event type with its strict payload contract', () => {
    expect(validDrafts).toHaveLength(Object.values(DurableEventType).length);
    expect(validDrafts.map((draft) => parseDurableEventDraft(draft).type)).toEqual(
      Object.values(DurableEventType),
    );
  });

  it('rejects missing and forbidden correlation identifiers', () => {
    expect(() =>
      parseDurableEventDraft({
        type: DurableEventType.REQUEST_ACCEPTED,
        requestId,
        data: {
          inputId: InputId('input-1'),
          input: 'hello',
          priority: 'next',
        },
      }),
    ).toThrow(/requires commandId/);

    expect(() =>
      parseDurableEventDraft({
        type: DurableEventType.SESSION_CREATED,
        requestId,
        data: {},
      }),
    ).toThrow(/does not allow requestId/);

    expect(() =>
      parseDurableEventDraft({
        type: DurableEventType.TOOL_STARTED,
        requestId,
        turnId,
        data: {
          toolCallId,
          toolName: 'Write',
          input: { file_path: '/tmp/file' },
          sideEffect: 'non_idempotent',
        },
      }),
    ).toThrow(/requires toolAttemptId/);
  });

  it('rejects unknown payload fields, non-finite JSON, and unknown event types', () => {
    expect(() =>
      parseDurableEventDraft({
        type: DurableEventType.REQUEST_STARTED,
        requestId,
        data: { unexpected: true },
      }),
    ).toThrow();

    expect(() =>
      parseDurableEventDraft({
        type: DurableEventType.REQUEST_ACCEPTED,
        requestId,
        commandId,
        data: {
          inputId: InputId('input-1'),
          input: 'hello',
          priority: 'next',
          recovery: {
            requestId: RequestId('source-request'),
            turnId: TurnId('source-turn'),
            turn: 0,
          },
        },
      }),
    ).toThrow();

    expect(() =>
      parseDurableEventDraft({
        type: DurableEventType.REQUEST_ACCEPTED,
        requestId,
        commandId,
        data: {
          inputId: InputId('input-1'),
          input: 'hello',
          priority: 'next',
          maxTurns: Number.POSITIVE_INFINITY,
        },
      }),
    ).toThrow();

    expect(() =>
      parseDurableEventDraft({
        type: DurableEventType.REQUEST_ACCEPTED,
        requestId,
        commandId,
        data: {
          inputId: InputId('input-1'),
          input: Number.POSITIVE_INFINITY,
          priority: 'next',
        },
      }),
    ).toThrow();

    expect(() =>
      parseDurableEventDraft({
        type: 'future_event',
        data: {},
      }),
    ).toThrow();

    expect(() =>
      parseDurableEventDraft({
        type: DurableEventType.TOOL_SCHEDULED,
        requestId,
        turnId,
        toolAttemptId,
        data: {
          toolCallId,
          toolName: 'Write',
          input: {},
          sideEffect: 'unknown',
          interruptBehavior: 'block',
        },
      }),
    ).toThrow();

    expect(() =>
      parseDurableEventEnvelope({
        ...validDrafts[0],
        schemaVersion: DURABLE_EVENT_SCHEMA_VERSION,
        eventId: EventId('event-unsafe-sequence'),
        sequence: Number.MAX_SAFE_INTEGER + 1,
        sessionId: 'session-1',
        recordedAt: '2026-08-22T12:00:00.000Z',
        occurredAt: '2026-08-22T12:00:00.000Z',
      }),
    ).toThrow();
  });

  it('parses a complete envelope after validating its event-specific payload', () => {
    const parsed = parseDurableEventEnvelope({
      ...validDrafts[2],
      schemaVersion: DURABLE_EVENT_SCHEMA_VERSION,
      eventId: EventId('event-1'),
      sequence: 1,
      sessionId: 'session-1',
      recordedAt: '2026-08-22T12:00:00.000Z',
      occurredAt: '2026-08-22T11:59:59.000Z',
    });

    expect(parsed).toMatchObject({
      type: DurableEventType.REQUEST_ACCEPTED,
      eventId: 'event-1',
      sequence: 1,
      sessionId: 'session-1',
      requestId: 'request-1',
      commandId: 'command-1',
    });
  });

  it('rejects pre-side-effect-contract schema versions', () => {
    expect(() =>
      parseDurableEventEnvelope({
        ...validDrafts[0],
        schemaVersion: 1,
        eventId: EventId('event-v1'),
        sequence: 1,
        sessionId: 'session-1',
        recordedAt: '2026-08-22T12:00:00.000Z',
        occurredAt: '2026-08-22T12:00:00.000Z',
      }),
    ).toThrow();
  });
});
