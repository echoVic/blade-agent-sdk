import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolErrorType } from '../../../tools/types/ToolResult.js';
import {
  CommandId,
  EventId,
  InputId,
  ModelAttemptId,
  RequestId,
  SessionId,
  ToolUseId,
} from '../../../types/branded.js';
import type { JsonObject } from '../../../types/common.js';
import { DurableSessionJournal } from '../DurableSessionJournal.js';
import { JsonlDurableEventStore } from '../JsonlDurableEventStore.js';
import {
  durableRequestFinishFromLoopResult,
  SessionDurableRecorder,
  SessionDurableRecorderError,
} from '../SessionDurableRecorder.js';
import { DurableEventType } from '../types.js';

describe('SessionDurableRecorder', () => {
  let storageRoot: string;
  let store: JsonlDurableEventStore;
  let journal: DurableSessionJournal;
  let recorder: SessionDurableRecorder;
  const sessionId = SessionId('session-recorder');
  const requestId = RequestId('request-1');
  const inputId = InputId('input-1');

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'session-durable-recorder-'));
    let nextEventId = 0;
    store = new JsonlDurableEventStore(storageRoot, {
      clock: () => new Date('2026-08-22T12:00:00.000Z'),
      eventIdFactory: () => EventId(`event-${++nextEventId}`),
    });
    journal = await DurableSessionJournal.open(store, sessionId);
    await journal.commit({
      commandId: CommandId('command-create'),
      events: [
        {
          type: DurableEventType.SESSION_CREATED,
          data: { source: 'create' },
        },
      ],
    });
    recorder = new SessionDurableRecorder(journal, requestId, 'test-model');
  });

  async function recordCompletedModelTool(
    toolCallId: ToolUseId,
    toolName: string,
    modelInput: JsonObject,
  ): Promise<ModelAttemptId> {
    const modelRequest = await recorder.onModelRequestStarting({
      turn: 1,
      model: 'test-model',
      streaming: false,
    });
    await modelRequest.onCompleted({
      content: '',
      toolCalls: [
        {
          id: toolCallId,
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify(modelInput),
          },
        },
      ],
    });
    if (!modelRequest.modelAttemptId) {
      throw new Error('Expected durable model attempt ID');
    }
    return modelRequest.modelAttemptId;
  }

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('records a complete request, turn, permission, and tool lifecycle', async () => {
    await recorder.recordAccepted(inputId, 'run write', 'next', {
      maxTurns: 17,
      context: {
        id: 'request-context',
        environment: { REGION: 'test' },
      },
    });
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });
    const modelRequest = await recorder.onModelRequestStarting({
      turn: 1,
      model: 'test-model',
      streaming: false,
    });
    await modelRequest.onCompleted({
      content: '',
      toolCalls: [
        {
          id: 'tool-call-1',
          type: 'function',
          function: {
            name: 'Write',
            arguments: '{"file_path":"/tmp/file"}',
          },
        },
      ],
      usage: {
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 12,
      },
    });
    if (!modelRequest.modelAttemptId) {
      throw new Error('Expected durable model attempt ID');
    }

    const lifecycle = await recorder.onToolScheduled({
      toolCallId: ToolUseId('tool-call-1'),
      toolName: 'Write',
      modelAttemptId: modelRequest.modelAttemptId,
      modelInput: { file_path: '/tmp/file' },
      input: { file_path: '/tmp/file' },
      sideEffect: 'non_idempotent',
      interruptBehavior: 'block',
    });
    const permissionRequestId = await lifecycle.onPermissionRequested?.(
      { message: 'Allow write?' },
      { file_path: '/tmp/file' },
    );
    if (!permissionRequestId) {
      throw new Error('Expected permission request ID');
    }
    await lifecycle.onPermissionResolved?.({
      permissionRequestId,
      decision: 'allow',
    });
    await lifecycle.onExecutionStarted?.({
      input: { file_path: '/tmp/approved-file' },
      sideEffect: 'idempotent',
    });
    await recorder.onToolSettled({
      toolCallId: ToolUseId('tool-call-1'),
      toolName: 'Write',
      result: {
        status: 'success',
        model: { changed: true },
      },
    });
    await recorder.recordAgentEvent({
      type: 'turn_end',
      turn: 1,
      hasToolCalls: true,
    });
    await recorder.finish({
      status: 'completed',
      output: 'done',
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        maxContextTokens: 100,
      },
    });

    const events = (await store.read(sessionId)).events;
    expect(events.map((event) => event.type)).toEqual([
      'session_created',
      'request_accepted',
      'input_applied',
      'request_started',
      'turn_started',
      'model_request_started',
      'model_request_completed',
      'tool_scheduled',
      'permission_requested',
      'permission_resolved',
      'tool_started',
      'tool_completed',
      'turn_completed',
      'request_completed',
    ]);
    const turnCompleted = events.find((event) => event.type === DurableEventType.TURN_COMPLETED);
    const requestCompleted = events.find(
      (event) => event.type === DurableEventType.REQUEST_COMPLETED,
    );
    expect(requestCompleted?.causationEventId).toBe(turnCompleted?.eventId);
    expect(
      events.find(
        (event) => event.type === DurableEventType.REQUEST_ACCEPTED,
      )?.data,
    ).toMatchObject({
      maxTurns: 17,
      model: 'test-model',
      context: {
        id: 'request-context',
        environment: { REGION: 'test' },
      },
    });
    expect(events.find(
      (event) => event.type === DurableEventType.TOOL_SCHEDULED,
    )).toMatchObject({
      modelAttemptId: modelRequest.modelAttemptId,
      data: {
        modelInput: { file_path: '/tmp/file' },
        input: { file_path: '/tmp/file' },
        sideEffect: 'non_idempotent',
      },
    });
    expect(
      (await store.read(sessionId)).events.find(
        (event) => event.type === DurableEventType.TOOL_STARTED,
      )?.data,
    ).toMatchObject({
      input: { file_path: '/tmp/approved-file' },
      sideEffect: 'idempotent',
    });
    expect(journal.getProjection().activeRequest).toBeNull();
  });

  it('requires reconciliation when a model request has no durable outcome', async () => {
    await recorder.recordAccepted(inputId, 'run');
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });
    await recorder.onModelRequestStarting({
      turn: 1,
      model: 'test-model',
      streaming: true,
    });

    expect(journal.getRecoveryPlan()).toMatchObject({
      action: 'reconcile_model_outcome',
      requestId,
    });
    await expect(
      recorder.finish({
        status: 'failed',
        error: new Error('worker stopped'),
      }),
    ).rejects.toThrow(/Model attempt .* is still active/);
    expect((await store.read(sessionId)).events.at(-1)?.type).toBe(
      DurableEventType.MODEL_REQUEST_STARTED,
    );
  });

  it('preserves model failure classification in the durable outcome', async () => {
    await recorder.recordAccepted(inputId, 'run');
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });
    const modelRequest = await recorder.onModelRequestStarting({
      turn: 1,
      model: 'test-model',
      streaming: false,
    });
    const modelError = Object.assign(new Error('provider overloaded'), {
      code: 'MODEL_OVERLOADED',
      retryable: true,
    });

    await modelRequest.onFailed(modelError);

    expect((await store.read(sessionId)).events.at(-1)).toMatchObject({
      type: DurableEventType.MODEL_REQUEST_FAILED,
      data: {
        error: {
          message: 'provider overloaded',
          code: 'MODEL_OVERLOADED',
          retryable: true,
        },
      },
    });
    expect(journal.getRecoveryPlan().action).toBe('resume_turn');
  });

  it('rejects a tool schedule from a superseded model attempt', async () => {
    await recorder.recordAccepted(inputId, 'retry');
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });
    const first = await recorder.onModelRequestStarting({
      turn: 1,
      model: 'test-model',
      streaming: false,
    });
    if (!first.modelAttemptId) {
      throw new Error('Expected durable model attempt ID');
    }
    const activeTurnId = journal.getProjection().activeRequest?.activeTurn?.turnId;
    if (!activeTurnId) {
      throw new Error('Expected active turn ID');
    }
    const competingAttemptId = ModelAttemptId('competing-model-attempt');
    const competingJournal = await DurableSessionJournal.open(store, sessionId);
    await competingJournal.commit({
      commandId: CommandId('competing-model-retry'),
      events: [
        {
          type: DurableEventType.MODEL_REQUEST_FAILED,
          requestId,
          turnId: activeTurnId,
          modelAttemptId: first.modelAttemptId,
          data: {
            error: { message: 'retry' },
          },
        },
        {
          type: DurableEventType.MODEL_REQUEST_STARTED,
          requestId,
          turnId: activeTurnId,
          modelAttemptId: competingAttemptId,
          data: {
            model: 'test-model',
            streaming: false,
          },
        },
      ],
    });

    await expect(
      recorder.onToolScheduled({
        toolCallId: ToolUseId('stale-tool-call'),
        toolName: 'Read',
        modelAttemptId: first.modelAttemptId,
        modelInput: {},
        input: {},
        sideEffect: 'pure',
        interruptBehavior: 'cancel',
      }),
    ).rejects.toThrow(/does not belong to the current model attempt/);
    expect(journal.getRecoveryPlan()).toMatchObject({
      action: 'reconcile_model_outcome',
      activeModelAttempt: {
        modelAttemptId: competingAttemptId,
      },
    });
  });

  it('serializes model completion after a concurrent tool schedule', async () => {
    await recorder.recordAccepted(inputId, 'stream a tool');
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });
    const modelRequest = await recorder.onModelRequestStarting({
      turn: 1,
      model: 'test-model',
      streaming: true,
    });
    if (!modelRequest.modelAttemptId) {
      throw new Error('Expected durable model attempt ID');
    }

    const scheduled = recorder.onToolScheduled({
      toolCallId: ToolUseId('streaming-tool-call'),
      toolName: 'Read',
      modelAttemptId: modelRequest.modelAttemptId,
      modelInput: { file_path: '/tmp/file' },
      input: { file_path: '/tmp/file' },
      sideEffect: 'pure',
      interruptBehavior: 'cancel',
    });
    const completed = modelRequest.onCompleted({
      content: '',
      toolCalls: [
        {
          id: 'streaming-tool-call',
          type: 'function',
          function: {
            name: 'Read',
            arguments: '{"file_path":"/tmp/file"}',
          },
        },
      ],
    });

    await expect(Promise.all([scheduled, completed])).resolves.toHaveLength(2);
    expect((await store.read(sessionId)).events.slice(-2).map((event) => event.type)).toEqual([
      DurableEventType.TOOL_SCHEDULED,
      DurableEventType.MODEL_REQUEST_COMPLETED,
    ]);
    expect(journal.getRecoveryPlan()).toMatchObject({
      action: 'resume_turn',
      activeModelAttempt: null,
      retryableToolAttempts: [
        expect.objectContaining({
          toolCallId: 'streaming-tool-call',
          modelAttemptId: modelRequest.modelAttemptId,
        }),
      ],
    });
  });

  it('persists steering input application before preparation and confirms it once', async () => {
    const steeringInputId = InputId('steering-input');
    await recorder.recordAccepted(inputId, 'run');
    await recorder.recordStarted(inputId);

    await recorder.onInputApplying({
      inputId: steeringInputId,
      priority: 'next',
    });

    expect((await store.read(sessionId)).events.at(-1)).toMatchObject({
      type: DurableEventType.INPUT_APPLIED,
      requestId,
      data: {
        inputId: steeringInputId,
        priority: 'next',
      },
    });

    await recorder.recordAgentEvent({
      type: 'input_applied',
      inputId: steeringInputId,
      requestId,
      priority: 'next',
      turn: 1,
    });

    expect(
      (await store.read(sessionId)).events.filter(
        (event) =>
          event.type === DurableEventType.INPUT_APPLIED
          && event.data.inputId === steeringInputId,
      ),
    ).toHaveLength(1);
  });

  it('binds a pre-turn terminal event to the latest Request boundary', async () => {
    const steeringInputId = InputId('terminal-steering-input');
    await recorder.recordAccepted(inputId, 'run');
    await recorder.recordStarted(inputId);
    await recorder.onInputApplying({
      inputId: steeringInputId,
      priority: 'next',
    });

    await recorder.finish({
      status: 'failed',
      error: new Error('preparation failed'),
    });

    const events = (await store.read(sessionId)).events;
    const inputApplied = events.at(-2);
    const requestFailed = events.at(-1);
    expect(inputApplied).toMatchObject({
      type: DurableEventType.INPUT_APPLIED,
      data: { inputId: steeringInputId },
    });
    expect(requestFailed).toMatchObject({
      type: DurableEventType.REQUEST_FAILED,
      causationEventId: inputApplied?.eventId,
    });
  });

  it('rejects a steering event that did not cross the durable application boundary', async () => {
    await recorder.recordAccepted(inputId, 'run');
    await recorder.recordStarted(inputId);

    await expect(
      recorder.recordAgentEvent({
        type: 'input_applied',
        inputId: InputId('unpersisted-steering-input'),
        requestId,
        priority: 'next',
        turn: 1,
      }),
    ).rejects.toThrow(/was not persisted before preparation/);
  });

  it('does not rebase steering input application across a stale journal head', async () => {
    await recorder.recordAccepted(inputId, 'run');
    await recorder.recordStarted(inputId);
    const competingJournal = await DurableSessionJournal.open(store, sessionId);
    await competingJournal.commit({
      commandId: CommandId('competing-input'),
      events: [
        {
          type: DurableEventType.INPUT_APPLIED,
          requestId,
          data: {
            inputId: InputId('competing-steering-input'),
            priority: 'next',
          },
        },
      ],
    });

    await expect(
      recorder.onInputApplying({
        inputId: InputId('stale-steering-input'),
        priority: 'next',
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_EVENT_SEQUENCE_CONFLICT',
    });

    await expect(
      recorder.finish({
        status: 'failed',
        error: new Error('input application failed'),
      }),
    ).rejects.toThrow(/fenced after a durable boundary failure/);

    const events = (await store.read(sessionId)).events;
    expect(
      events.some(
        (event) =>
          event.type === DurableEventType.REQUEST_COMPLETED
          || event.type === DurableEventType.REQUEST_FAILED
          || event.type === DurableEventType.REQUEST_INTERRUPTED,
      ),
    ).toBe(false);
    expect(journal.getRecoveryPlan()).toMatchObject({
      action: 'reconcile_request_inputs',
      requestId,
    });
  });

  it('does not rebase a Request terminal event over a concurrent input application', async () => {
    await recorder.recordAccepted(inputId, 'run');
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });
    await recorder.recordAgentEvent({
      type: 'turn_end',
      turn: 1,
      hasToolCalls: false,
    });
    const competingJournal = await DurableSessionJournal.open(store, sessionId);
    await competingJournal.commit({
      commandId: CommandId('competing-terminal-input'),
      events: [
        {
          type: DurableEventType.INPUT_APPLIED,
          requestId,
          data: {
            inputId: InputId('terminal-race-input'),
            priority: 'next',
          },
        },
      ],
    });

    await expect(
      recorder.finish({
        status: 'completed',
        output: 'stale result',
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_EVENT_SEQUENCE_CONFLICT',
    });
  });

  it('records a denied permission as a cancelled tool without starting it', async () => {
    await recorder.recordAccepted(inputId, 'run write');
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });
    const modelAttemptId = await recordCompletedModelTool(
      ToolUseId('tool-call-1'),
      'Write',
      {},
    );
    const lifecycle = await recorder.onToolScheduled({
      toolCallId: ToolUseId('tool-call-1'),
      toolName: 'Write',
      modelAttemptId,
      modelInput: {},
      input: {},
      sideEffect: 'non_idempotent',
      interruptBehavior: 'block',
    });
    const permissionRequestId = await lifecycle.onPermissionRequested?.({ message: 'Allow?' }, {});
    if (!permissionRequestId) {
      throw new Error('Expected permission request ID');
    }
    await lifecycle.onPermissionResolved?.({
      permissionRequestId,
      decision: 'deny',
      message: 'No',
    });
    await recorder.onToolSettled({
      toolCallId: ToolUseId('tool-call-1'),
      toolName: 'Write',
      result: {
        status: 'error',
        model: 'denied',
        error: {
          type: ToolErrorType.PERMISSION_DENIED,
          message: 'No',
        },
      },
    });

    const types = (await store.read(sessionId)).events.map((event) => event.type);
    expect(types).toContain(DurableEventType.PERMISSION_RESOLVED);
    expect(types).toContain(DurableEventType.TOOL_CANCELLED);
    expect(types).not.toContain(DurableEventType.TOOL_STARTED);
  });

  it('records pre-execution validation failures as failed tools', async () => {
    await recorder.recordAccepted(inputId, 'run invalid tool');
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });
    const modelAttemptId = await recordCompletedModelTool(
      ToolUseId('tool-call-1'),
      'Write',
      {},
    );
    await recorder.onToolScheduled({
      toolCallId: ToolUseId('tool-call-1'),
      toolName: 'Write',
      modelAttemptId,
      modelInput: {},
      input: {},
      sideEffect: 'non_idempotent',
      interruptBehavior: 'block',
    });
    await recorder.onToolSettled({
      toolCallId: ToolUseId('tool-call-1'),
      toolName: 'Write',
      result: {
        status: 'error',
        model: 'invalid',
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: 'Invalid input',
        },
      },
    });

    expect((await store.read(sessionId)).events.map((event) => event.type)).toEqual(
      expect.arrayContaining([DurableEventType.TOOL_SCHEDULED, DurableEventType.TOOL_FAILED]),
    );
  });

  it('closes scheduled work before aborting a turn and request', async () => {
    await recorder.recordAccepted(inputId, 'run tool');
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });
    const modelAttemptId = await recordCompletedModelTool(
      ToolUseId('tool-call-1'),
      'Write',
      {},
    );
    await recorder.onToolScheduled({
      toolCallId: ToolUseId('tool-call-1'),
      toolName: 'Write',
      modelAttemptId,
      modelInput: {},
      input: {},
      sideEffect: 'non_idempotent',
      interruptBehavior: 'block',
    });

    await expect(
      recorder.finish({
        status: 'interrupted',
        reason: 'user_abort',
      }),
    ).resolves.toBe(true);

    expect((await store.read(sessionId)).events.map((event) => event.type).slice(-3)).toEqual([
      DurableEventType.TOOL_CANCELLED,
      DurableEventType.TURN_ABORTED,
      DurableEventType.REQUEST_INTERRUPTED,
    ]);
  });

  it('rejects successful request completion while a turn is still active', async () => {
    await recorder.recordAccepted(inputId, 'run');
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });

    await expect(recorder.finish({
      status: 'completed',
      output: 'invalid',
    })).rejects.toBeInstanceOf(SessionDurableRecorderError);
    expect(journal.getRecoveryPlan().action).toBe('resume_turn');
  });

  it('leaves a started tool recoverable instead of inventing a terminal outcome', async () => {
    await recorder.recordAccepted(inputId, 'run tool');
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });
    const modelAttemptId = await recordCompletedModelTool(
      ToolUseId('tool-call-1'),
      'Write',
      {},
    );
    const lifecycle = await recorder.onToolScheduled({
      toolCallId: ToolUseId('tool-call-1'),
      toolName: 'Write',
      modelAttemptId,
      modelInput: {},
      input: {},
      sideEffect: 'non_idempotent',
      interruptBehavior: 'block',
    });
    await lifecycle.onExecutionStarted?.({
      input: {},
      sideEffect: 'non_idempotent',
    });

    await expect(
      recorder.finish({
        status: 'failed',
        error: new Error('worker disappeared'),
      }),
    ).resolves.toBe(false);
    expect(journal.getRecoveryPlan()).toMatchObject({
      action: 'reconcile_tool_outcomes',
      requestId,
      unknownToolAttempts: [
        expect.objectContaining({
          toolCallId: 'tool-call-1',
          status: 'started',
        }),
      ],
    });
    expect((await store.read(sessionId)).events.at(-1)?.type).toBe(DurableEventType.TOOL_STARTED);
  });

  it('preserves the active Turn when a Request is suspended for handoff', async () => {
    await recorder.recordAccepted(inputId, 'handoff');
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });
    await recorder.onModelRequestStarting({
      turn: 1,
      model: 'test-model',
      streaming: true,
    });

    expect(recorder.beginHandoff()).toBe(true);
    await recorder.recordAgentEvent({
      type: 'turn_end',
      turn: 1,
      hasToolCalls: false,
    });
    await expect(
      recorder.finish({
        status: 'interrupted',
        reason: 'process_restart',
      }),
    ).resolves.toBe(true);
    await recorder.finalizeHandoff();

    expect(journal.getRecoveryPlan()).toMatchObject({
      action: 'resume_turn',
      requestId,
    });
    expect((await store.read(sessionId)).events.map((event) => event.type).slice(-2)).toEqual([
      DurableEventType.MODEL_REQUEST_STARTED,
      DurableEventType.MODEL_REQUEST_ABORTED,
    ]);
    await expect(
      recorder.onModelRequestStarting({
        turn: 1,
        model: 'test-model',
        streaming: true,
      }),
    ).rejects.toThrow(/suspended for worker handoff/);
  });

  it('marks an unsettled started tool outcome unknown during handoff', async () => {
    await recorder.recordAccepted(inputId, 'handoff tool');
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });
    const modelAttemptId = await recordCompletedModelTool(
      ToolUseId('handoff-tool-call'),
      'Write',
      {},
    );
    const lifecycle = await recorder.onToolScheduled({
      toolCallId: ToolUseId('handoff-tool-call'),
      toolName: 'Write',
      modelAttemptId,
      modelInput: {},
      input: {},
      sideEffect: 'non_idempotent',
      interruptBehavior: 'block',
    });
    await lifecycle.onExecutionStarted?.({
      input: {},
      sideEffect: 'non_idempotent',
    });

    recorder.beginHandoff();
    await recorder.onToolSettled({
      toolCallId: ToolUseId('handoff-tool-call'),
      toolName: 'Write',
      result: {
        status: 'error',
        model: 'interrupted',
        error: {
          type: ToolErrorType.INTERRUPTED,
          message: 'worker handoff',
        },
      },
    });
    await recorder.finalizeHandoff();

    expect(journal.getRecoveryPlan()).toMatchObject({
      action: 'reconcile_tool_outcomes',
      requestId,
      unknownToolAttempts: [
        expect.objectContaining({
          toolCallId: 'handoff-tool-call',
          status: 'outcome_unknown',
        }),
      ],
    });
    expect((await store.read(sessionId)).events.at(-1)?.type).toBe(
      DurableEventType.TOOL_OUTCOME_UNKNOWN,
    );
  });

  it('cancels scheduled tools and pending permissions without ending the handoff Turn', async () => {
    await recorder.recordAccepted(inputId, 'handoff permission');
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });
    const toolCallId = ToolUseId('handoff-permission-tool');
    const modelAttemptId = await recordCompletedModelTool(
      toolCallId,
      'Write',
      {},
    );
    const lifecycle = await recorder.onToolScheduled({
      toolCallId,
      toolName: 'Write',
      modelAttemptId,
      modelInput: {},
      input: {},
      sideEffect: 'non_idempotent',
      interruptBehavior: 'block',
    });
    await lifecycle.onPermissionRequested?.(
      { message: 'Allow write?' },
      {},
    );

    recorder.beginHandoff();
    await recorder.onToolSettled({
      toolCallId,
      toolName: 'Write',
      result: {
        status: 'error',
        model: 'cancelled',
        error: {
          type: ToolErrorType.INTERRUPTED,
          message: 'cancelled',
        },
      },
    });
    await recorder.finalizeHandoff();

    expect(journal.getRecoveryPlan()).toMatchObject({
      action: 'resume_turn',
      pendingPermissions: [],
      cancelableToolAttempts: [],
    });
    expect((await store.read(sessionId)).events.map((event) => event.type).slice(-2)).toEqual([
      DurableEventType.PERMISSION_RESOLVED,
      DurableEventType.TOOL_CANCELLED,
    ]);
  });

  it('opens a recovery Turn when handoff lands between tool-backed Turns', async () => {
    await recorder.recordAccepted(inputId, 'continue after tool');
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });
    const toolCallId = ToolUseId('completed-handoff-tool');
    const modelAttemptId = await recordCompletedModelTool(
      toolCallId,
      'Read',
      {},
    );
    const lifecycle = await recorder.onToolScheduled({
      toolCallId,
      toolName: 'Read',
      modelAttemptId,
      modelInput: {},
      input: {},
      sideEffect: 'pure',
      interruptBehavior: 'cancel',
    });
    await lifecycle.onExecutionStarted?.({
      input: {},
      sideEffect: 'pure',
    });
    await recorder.onToolSettled({
      toolCallId,
      toolName: 'Read',
      result: {
        status: 'success',
        model: 'done',
      },
    });
    await recorder.recordAgentEvent({
      type: 'turn_end',
      turn: 1,
      hasToolCalls: true,
    });

    recorder.beginHandoff();
    await recorder.finalizeHandoff();

    expect(journal.getRecoveryPlan()).toMatchObject({
      action: 'resume_turn',
      requestId,
      turnId: expect.any(String),
    });
    expect((await store.read(sessionId)).events.at(-1)).toMatchObject({
      type: DurableEventType.TURN_STARTED,
      data: { turn: 2 },
    });
  });

  it('blocks steering past a started tool with an unknown outcome', async () => {
    await recorder.recordAccepted(inputId, 'run tool');
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });
    const modelAttemptId = await recordCompletedModelTool(
      ToolUseId('tool-call-1'),
      'Write',
      {},
    );
    const lifecycle = await recorder.onToolScheduled({
      toolCallId: ToolUseId('tool-call-1'),
      toolName: 'Write',
      modelAttemptId,
      modelInput: {},
      input: {},
      sideEffect: 'non_idempotent',
      interruptBehavior: 'block',
    });
    await lifecycle.onExecutionStarted?.({
      input: {},
      sideEffect: 'non_idempotent',
    });

    await expect(
      recorder.recordAgentEvent({
        type: 'turn_interrupted',
        inputId: InputId('steering-input'),
        requestId,
        turn: 1,
      }),
    ).rejects.toBeInstanceOf(SessionDurableRecorderError);
    expect(journal.getRecoveryPlan().action).toBe('reconcile_tool_outcomes');
  });

  it('rejects duplicate tool settlement', async () => {
    await recorder.recordAccepted(inputId, 'run tool');
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });
    const toolCallId = ToolUseId('tool-call-1');
    const modelAttemptId = await recordCompletedModelTool(toolCallId, 'Read', {});
    const lifecycle = await recorder.onToolScheduled({
      toolCallId,
      toolName: 'Read',
      modelAttemptId,
      modelInput: {},
      input: {},
      sideEffect: 'pure',
      interruptBehavior: 'cancel',
    });
    await lifecycle.onExecutionStarted?.({
      input: {},
      sideEffect: 'pure',
    });
    const settled = {
      toolCallId,
      toolName: 'Read',
      result: {
        status: 'success' as const,
        model: 'done',
      },
    };
    await recorder.onToolSettled(settled);

    await expect(recorder.onToolSettled(settled)).rejects.toBeInstanceOf(
      SessionDurableRecorderError,
    );
  });

  it('reserves a tool call ID before its durable schedule commit completes', async () => {
    await recorder.recordAccepted(inputId, 'run tool');
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });
    const toolCallId = ToolUseId('tool-call-1');
    const modelAttemptId = await recordCompletedModelTool(toolCallId, 'Read', {});

    const first = recorder.onToolScheduled({
      toolCallId,
      toolName: 'Read',
      modelAttemptId,
      modelInput: {},
      input: {},
      sideEffect: 'pure',
      interruptBehavior: 'cancel',
    });
    const duplicate = recorder.onToolScheduled({
      toolCallId,
      toolName: 'Read',
      modelAttemptId,
      modelInput: {},
      input: {},
      sideEffect: 'pure',
      interruptBehavior: 'cancel',
    });

    await Promise.all([
      expect(first).resolves.toBeDefined(),
      expect(duplicate).rejects.toBeInstanceOf(SessionDurableRecorderError),
    ]);
    expect(
      (await store.read(sessionId)).events.filter(
        (event) => event.type === DurableEventType.TOOL_SCHEDULED,
      ),
    ).toHaveLength(1);
  });

  it('maps loop results to durable terminal outcomes', () => {
    expect(
      durableRequestFinishFromLoopResult(
        {
          success: true,
          finalMessage: 'done',
        },
        {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          maxContextTokens: 100,
        },
      ),
    ).toMatchObject({
      status: 'completed',
      output: 'done',
    });
    expect(
      durableRequestFinishFromLoopResult(
        {
          success: false,
          error: { type: 'aborted', message: 'aborted' },
        },
        {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          maxContextTokens: 100,
        },
      ),
    ).toEqual({
      status: 'interrupted',
      reason: 'user_abort',
    });
    expect(
      durableRequestFinishFromLoopResult(
        {
          success: false,
          error: { type: 'aborted', message: 'closed' },
        },
        {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          maxContextTokens: 100,
        },
        'session_close',
      ),
    ).toEqual({
      status: 'interrupted',
      reason: 'session_close',
    });
  });
});
