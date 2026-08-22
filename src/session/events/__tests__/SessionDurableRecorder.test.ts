import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolErrorType } from '../../../tools/types/ToolResult.js';
import {
  CommandId,
  EventId,
  InputId,
  RequestId,
  SessionId,
  ToolUseId,
} from '../../../types/branded.js';
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

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('records a complete request, turn, permission, and tool lifecycle', async () => {
    await recorder.recordAccepted(inputId, 'run write');
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });

    const lifecycle = await recorder.onToolScheduled({
      toolCallId: ToolUseId('tool-call-1'),
      toolName: 'Write',
      input: { file_path: '/tmp/file' },
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
    await lifecycle.onExecutionStarted?.();
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

    expect((await store.read(sessionId)).events.map((event) => event.type)).toEqual([
      'session_created',
      'request_accepted',
      'input_applied',
      'request_started',
      'turn_started',
      'tool_scheduled',
      'permission_requested',
      'permission_resolved',
      'tool_started',
      'tool_completed',
      'turn_completed',
      'request_completed',
    ]);
    expect(journal.getProjection().activeRequest).toBeNull();
  });

  it('records a denied permission as a cancelled tool without starting it', async () => {
    await recorder.recordAccepted(inputId, 'run write');
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });
    const lifecycle = await recorder.onToolScheduled({
      toolCallId: ToolUseId('tool-call-1'),
      toolName: 'Write',
      input: {},
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
    await recorder.onToolScheduled({
      toolCallId: ToolUseId('tool-call-1'),
      toolName: 'Write',
      input: {},
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
    await recorder.onToolScheduled({
      toolCallId: ToolUseId('tool-call-1'),
      toolName: 'Write',
      input: {},
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
    const lifecycle = await recorder.onToolScheduled({
      toolCallId: ToolUseId('tool-call-1'),
      toolName: 'Write',
      input: {},
      interruptBehavior: 'block',
    });
    await lifecycle.onExecutionStarted?.();

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

  it('blocks steering past a started tool with an unknown outcome', async () => {
    await recorder.recordAccepted(inputId, 'run tool');
    await recorder.recordStarted(inputId);
    await recorder.recordAgentEvent({
      type: 'turn_start',
      turn: 1,
      maxTurns: 10,
    });
    const lifecycle = await recorder.onToolScheduled({
      toolCallId: ToolUseId('tool-call-1'),
      toolName: 'Write',
      input: {},
      interruptBehavior: 'block',
    });
    await lifecycle.onExecutionStarted?.();

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
    const lifecycle = await recorder.onToolScheduled({
      toolCallId,
      toolName: 'Read',
      input: {},
      interruptBehavior: 'cancel',
    });
    await lifecycle.onExecutionStarted?.();
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

    const first = recorder.onToolScheduled({
      toolCallId,
      toolName: 'Read',
      input: {},
      interruptBehavior: 'cancel',
    });
    const duplicate = recorder.onToolScheduled({
      toolCallId,
      toolName: 'Read',
      input: {},
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
