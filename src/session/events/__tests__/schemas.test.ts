import { describe, expect, it } from 'vitest';
import {
  CommandId,
  EventId,
  InputId,
  ModelAttemptId,
  PermissionRequestId,
  RequestId,
  ToolAttemptId,
  ToolUseId,
  TurnId,
} from '../../../types/branded.js';
import {
  DURABLE_EVENT_LOG_FORMAT,
  parseDurableEventDraft,
  parseDurableEventEnvelope,
  parsePersistedDurableEventBatch,
} from '../schemas.js';
import {
  DURABLE_EVENT_SCHEMA_VERSION,
  type DurableEventDraft,
  DurableEventType,
} from '../types.js';

const requestId = RequestId('request-1');
const commandId = CommandId('command-1');
const turnId = TurnId('turn-1');
const modelAttemptId = ModelAttemptId('model-attempt-1');
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
    type: DurableEventType.MODEL_REQUEST_STARTED,
    requestId,
    turnId,
    modelAttemptId,
    data: {
      model: 'claude-sonnet',
      modelIdentity: {
        provider: 'anthropic-primary',
        api: 'anthropic',
        model: 'claude-sonnet',
      },
      streaming: true,
    },
  },
  {
    type: DurableEventType.MODEL_REQUEST_COMPLETED,
    requestId,
    turnId,
    modelAttemptId,
    data: {
      response: {
        content: 'done',
        reasoningContent: 'reasoning',
        toolCalls: [
          {
            id: toolCallId,
            name: 'Write',
            arguments: '{"file_path":"/tmp/file"}',
          },
        ],
        usage: {
          promptTokens: 10,
          completionTokens: 2,
          totalTokens: 12,
          cacheReadInputTokens: 4,
        },
      },
    },
  },
  {
    type: DurableEventType.MODEL_REQUEST_FAILED,
    requestId,
    turnId,
    modelAttemptId,
    data: {
      error: { message: 'provider failed', code: 'MODEL_ERROR', retryable: true },
    },
  },
  {
    type: DurableEventType.MODEL_REQUEST_ABORTED,
    requestId,
    turnId,
    modelAttemptId,
    data: {
      reason: 'steering',
    },
  },
  {
    type: DurableEventType.TOOL_SCHEDULED,
    requestId,
    turnId,
    modelAttemptId,
    toolAttemptId,
    data: {
      toolCallId,
      toolName: 'Write',
      modelInput: { file_path: '/tmp/file' },
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

  it('reads schema-v2 logs but forbids model-attempt events in v2', () => {
    const legacyEvent = {
      ...validDrafts[0],
      schemaVersion: 2,
      eventId: EventId('legacy-event'),
      sequence: 1,
      sessionId: 'legacy-session',
      recordedAt: '2026-08-22T12:00:00.000Z',
      occurredAt: '2026-08-22T12:00:00.000Z',
    };
    expect(parseDurableEventEnvelope(legacyEvent).schemaVersion).toBe(2);
    expect(
      parsePersistedDurableEventBatch({
        format: DURABLE_EVENT_LOG_FORMAT,
        schemaVersion: 2,
        sessionId: 'legacy-session',
        firstSequence: 1,
        lastSequence: 1,
        events: [legacyEvent],
      }).schemaVersion,
    ).toBe(2);

    expect(() =>
      parseDurableEventEnvelope({
        ...validDrafts.find(
          (draft) => draft.type === DurableEventType.MODEL_REQUEST_STARTED,
        ),
        schemaVersion: 2,
        eventId: EventId('invalid-v2-model-event'),
        sequence: 1,
        sessionId: 'legacy-session',
        recordedAt: '2026-08-22T12:00:00.000Z',
        occurredAt: '2026-08-22T12:00:00.000Z',
      }),
    ).toThrow(/requires durable event schema v3/);
  });

  it('reads schema-v3 model attempts but reserves provider identity for schema v4', () => {
    const modelStarted = validDrafts.find(
      (draft) => draft.type === DurableEventType.MODEL_REQUEST_STARTED,
    );
    if (!modelStarted || modelStarted.type !== DurableEventType.MODEL_REQUEST_STARTED) {
      throw new Error('Expected model_request_started fixture');
    }
    const { modelIdentity: _modelIdentity, ...legacyData } = modelStarted.data;
    const envelope = {
      ...modelStarted,
      data: legacyData,
      schemaVersion: 3,
      eventId: EventId('schema-v3-model-event'),
      sequence: 1,
      sessionId: 'schema-v3-session',
      recordedAt: '2026-08-22T12:00:00.000Z',
      occurredAt: '2026-08-22T12:00:00.000Z',
    } as const;

    expect(parseDurableEventEnvelope(envelope).schemaVersion).toBe(3);
    expect(() =>
      parseDurableEventEnvelope({
        ...envelope,
        data: modelStarted.data,
      }),
    ).toThrow(/provider identity requires durable event schema v4/);
  });

  it('requires model-attempt identity and original input for schema-v3 and later tools', () => {
    const toolScheduled = validDrafts.find(
      (draft) => draft.type === DurableEventType.TOOL_SCHEDULED,
    );
    if (!toolScheduled || toolScheduled.type !== DurableEventType.TOOL_SCHEDULED) {
      throw new Error('Expected tool_scheduled fixture');
    }
    const { modelInput: _modelInput, ...legacyData } = toolScheduled.data;
    const { modelAttemptId: _modelAttemptId, ...legacyToolScheduled } = toolScheduled;
    const envelope = {
      ...legacyToolScheduled,
      data: legacyData,
      eventId: EventId('tool-without-model-input'),
      sequence: 1,
      sessionId: 'session-1',
      recordedAt: '2026-08-22T12:00:00.000Z',
      occurredAt: '2026-08-22T12:00:00.000Z',
    };

    expect(() =>
      parseDurableEventEnvelope({
        ...envelope,
        modelAttemptId,
        schemaVersion: DURABLE_EVENT_SCHEMA_VERSION,
      }),
    ).toThrow(/requires modelInput/);
    expect(() =>
      parseDurableEventEnvelope({
        ...envelope,
        data: toolScheduled.data,
        schemaVersion: DURABLE_EVENT_SCHEMA_VERSION,
      }),
    ).toThrow(/requires modelAttemptId/);
    expect(
      parseDurableEventEnvelope({
        ...envelope,
        schemaVersion: 2,
      }).schemaVersion,
    ).toBe(2);
    expect(() =>
      parseDurableEventEnvelope({
        ...envelope,
        modelAttemptId,
        schemaVersion: 2,
      }),
    ).toThrow(/does not allow modelAttemptId/);
    expect(() =>
      parseDurableEventEnvelope({
        ...envelope,
        data: toolScheduled.data,
        schemaVersion: 2,
      }),
    ).toThrow(/does not allow modelInput/);
  });

  it('rejects a persisted batch whose event version does not match', () => {
    expect(() =>
      parsePersistedDurableEventBatch({
        format: DURABLE_EVENT_LOG_FORMAT,
        schemaVersion: DURABLE_EVENT_SCHEMA_VERSION,
        sessionId: 'session-1',
        firstSequence: 1,
        lastSequence: 1,
        events: [
          {
            ...validDrafts[0],
            schemaVersion: 2,
            eventId: EventId('mixed-version-event'),
            sequence: 1,
            sessionId: 'session-1',
            recordedAt: '2026-08-22T12:00:00.000Z',
            occurredAt: '2026-08-22T12:00:00.000Z',
          },
        ],
      }),
    ).toThrow(/must match its batch/);
  });
});
