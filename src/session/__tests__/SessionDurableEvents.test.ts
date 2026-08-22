import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../agent/AgentEvent.js';
import type { LoopOptions, LoopResult, UserMessageContent } from '../../agent/types.js';
import {
  CommandId,
  EventId,
  InputId,
  RequestId,
  SessionId,
  ToolUseId,
} from '../../types/branded.js';
import type { JsonValue } from '../../types/common.js';
import { type DurableEventStore, DurableEventStoreError } from '../events/DurableEventStore.js';
import {
  DurableEventSubscriptionError,
  type DurableEventSubscriptionMessage,
} from '../events/DurableEventSubscription.js';
import {
  DurableCommandOutcomeUnknownError,
  DurableSessionJournal,
} from '../events/DurableSessionJournal.js';
import { JsonlDurableEventStore } from '../events/JsonlDurableEventStore.js';
import {
  DurableSessionRecoveryRequiredError,
  SessionDurableRecorderError,
} from '../events/SessionDurableRecorder.js';
import type {
  DurableEventAppendOptions,
  DurableEventAppendResult,
  DurableEventDraft,
  DurableEventPage,
  DurableEventReadOptions,
} from '../events/types.js';
import { DurableEventType } from '../events/types.js';

type StreamChat = (
  message: UserMessageContent,
  context: unknown,
  options?: LoopOptions,
) => AsyncGenerator<AgentEvent, LoopResult>;

let streamChat: StreamChat = async function* defaultStream() {
  yield { type: 'turn_start', turn: 1, maxTurns: 10 };
  yield { type: 'turn_end', turn: 1, hasToolCalls: false };
  return {
    success: true,
    finalMessage: 'done',
    metadata: { turnsCount: 1, toolCallsCount: 0, duration: 1 },
  };
};

const createAgent = vi.fn(async (_config?: unknown, _options?: unknown, _deps?: unknown) => ({
  streamChat: (message: UserMessageContent, context: unknown, options?: LoopOptions) =>
    streamChat(message, context, options),
  async setModel() {},
}));

vi.mock('../../agent/Agent.js', () => ({
  Agent: { create: createAgent },
}));

const { createSession, forkSession, resumeSession } = await import('../Session.js');

class FailOnEventTypeStore implements DurableEventStore {
  constructor(
    private readonly delegate: DurableEventStore,
    private readonly failedType: string,
  ) {}

  async append(
    sessionId: SessionId,
    events: readonly DurableEventDraft[],
    options?: DurableEventAppendOptions,
  ): Promise<DurableEventAppendResult> {
    if (events.some((event) => event.type === this.failedType)) {
      throw new DurableEventStoreError(
        'DURABLE_EVENT_WRITE_FAILED',
        `Injected ${this.failedType} failure`,
      );
    }
    return this.delegate.append(sessionId, events, options);
  }

  read(sessionId: SessionId, options?: DurableEventReadOptions): Promise<DurableEventPage> {
    return this.delegate.read(sessionId, options);
  }

  getHeadSequence(sessionId: SessionId) {
    return this.delegate.getHeadSequence(sessionId);
  }
}

const tempRoots: string[] = [];

function createStore() {
  const root = mkdtempSync(join(tmpdir(), 'session-durable-events-'));
  tempRoots.push(root);
  let eventId = 0;
  return {
    root,
    store: new JsonlDurableEventStore(root, {
      clock: () => new Date('2026-08-22T12:00:00.000Z'),
      eventIdFactory: () => EventId(`event-${++eventId}`),
    }),
  };
}

function options(store: DurableEventStore) {
  return {
    provider: { type: 'openai-compatible' as const, apiKey: 'test-key' },
    model: 'test-model',
    persistSession: false,
    durableEventStore: store,
  };
}

afterEach(async () => {
  streamChat = async function* defaultStream() {
    yield { type: 'turn_start', turn: 1, maxTurns: 10 };
    yield { type: 'turn_end', turn: 1, hasToolCalls: false };
    return {
      success: true,
      finalMessage: 'done',
      metadata: { turnsCount: 1, toolCallsCount: 0, duration: 1 },
    };
  };
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Session durable events', () => {
  it('persists request and turn boundaries before exposing stream events', async () => {
    const { store } = createStore();
    const session = await createSession(options(store));
    const submission = await session.send('hello');

    expect((await store.read(session.sessionId)).events.map((event) => event.type)).toEqual([
      DurableEventType.SESSION_CREATED,
      DurableEventType.REQUEST_ACCEPTED,
    ]);

    for await (const event of session.stream()) {
      const durableTypes = (await store.read(session.sessionId)).events.map((entry) => entry.type);
      if (event.type === 'turn_start') {
        expect(durableTypes.at(-1)).toBe(DurableEventType.TURN_STARTED);
      }
      if (event.type === 'result') {
        expect(durableTypes.at(-1)).toBe(DurableEventType.REQUEST_COMPLETED);
      }
    }

    expect(session.getDurableProjection()).toMatchObject({
      status: 'open',
      activeRequest: null,
    });
    expect(session.getDurableRecoveryPlan()?.action).toBe('none');
    expect(submission.status).toBe('started');

    await session.close();
    expect((await store.read(session.sessionId)).events.at(-1)?.type).toBe(
      DurableEventType.SESSION_CLOSED,
    );
  });

  it('exposes the durable event subscription through Session', async () => {
    const { store } = createStore();
    const session = await createSession(options(store));
    const subscription = await session.subscribeDurableEvents({
      follow: false,
    });
    const messages: DurableEventSubscriptionMessage[] = [];

    for await (const message of subscription) {
      messages.push(message);
    }

    expect(messages).toMatchObject([
      {
        type: 'event',
        event: { type: DurableEventType.SESSION_CREATED },
        phase: 'replay',
      },
      {
        type: 'caught_up',
        headSequence: 1,
      },
    ]);
    await session.close();
  });

  it('rejects Session event subscriptions without a durable Store', async () => {
    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'test-model',
      persistSession: false,
    });

    await expect(session.subscribeDurableEvents()).rejects.toBeInstanceOf(
      DurableEventSubscriptionError,
    );
    await session.close();
  });

  it('persists the accepted request execution snapshot before send returns', async () => {
    const { store } = createStore();
    const session = await createSession({
      ...options(store),
      maxTurns: 50,
      defaultContext: {
        id: 'default-context',
        environment: { DEFAULT: 'yes', OVERRIDE: 'before' },
      },
    });

    await session.send('snapshot me', {
      maxTurns: 9,
      context: {
        id: 'request-context',
        environment: { OVERRIDE: 'after' },
      },
    });

    expect(
      (await store.read(session.sessionId)).events.find(
        (event) => event.type === DurableEventType.REQUEST_ACCEPTED,
      )?.data,
    ).toMatchObject({
      input: 'snapshot me',
      maxTurns: 9,
      model: 'test-model',
      context: {
        id: 'request-context',
        environment: {
          DEFAULT: 'yes',
          OVERRIDE: 'after',
        },
      },
    });
    await session.abort();
    await session.close();
  });

  it('releases the external abort listener when durable acceptance fails', async () => {
    const { store } = createStore();
    const failingStore = new FailOnEventTypeStore(store, DurableEventType.REQUEST_ACCEPTED);
    const session = await createSession(options(failingStore));
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');

    await expect(
      session.send('must not leak', { signal: controller.signal }),
    ).rejects.toBeInstanceOf(DurableCommandOutcomeUnknownError);

    const abortListener = addListener.mock.calls.find(([type]) => type === 'abort')?.[1];
    expect(abortListener).toBeDefined();
    expect(removeListener).toHaveBeenCalledWith('abort', abortListener);
    expect(session.getPendingInputs()).toEqual([]);
    await expect(session.close()).rejects.toBeInstanceOf(DurableCommandOutcomeUnknownError);
  });

  it('persists tool and permission boundaries around the real side effect', async () => {
    const { store } = createStore();
    let sideEffectSawToolStarted = false;
    streamChat = async function* toolStream(_message, _context, loopOptions) {
      yield { type: 'turn_start', turn: 1, maxTurns: 10 };
      const lifecycle = loopOptions?.toolExecutionLifecycle;
      const invocation = await lifecycle?.onToolScheduled?.({
        toolCallId: ToolUseId('tool-call-1'),
        toolName: 'Write',
        input: { file_path: '/tmp/file' },
        sideEffect: 'non_idempotent',
        interruptBehavior: 'block',
      });
      if (!invocation) {
        throw new Error('Missing tool invocation lifecycle');
      }
      yield {
        type: 'tool_start',
        toolCall: {
          id: 'tool-call-1',
          type: 'function',
          function: { name: 'Write', arguments: '{"file_path":"/tmp/file"}' },
        },
      };
      const permissionRequestId = await invocation.onPermissionRequested?.(
        { message: 'Allow write?' },
        { file_path: '/tmp/file' },
      );
      if (!permissionRequestId) {
        throw new Error('Missing permission request ID');
      }
      await invocation.onPermissionResolved?.({
        permissionRequestId,
        decision: 'allow',
      });
      await invocation.onExecutionStarted?.({
        input: { file_path: '/tmp/file' },
        sideEffect: 'non_idempotent',
      });
      sideEffectSawToolStarted = (await store.read(sessionIdForTest)).events.some(
        (event) => event.type === DurableEventType.TOOL_STARTED,
      );
      await lifecycle?.onToolSettled?.({
        toolCallId: ToolUseId('tool-call-1'),
        toolName: 'Write',
        result: { status: 'success', model: 'written' },
      });
      yield {
        type: 'tool_result',
        toolCall: {
          id: 'tool-call-1',
          type: 'function',
          function: { name: 'Write', arguments: '{"file_path":"/tmp/file"}' },
        },
        result: { status: 'success', model: 'written' },
      };
      yield { type: 'turn_end', turn: 1, hasToolCalls: true };
      return {
        success: true,
        finalMessage: 'done',
        metadata: { turnsCount: 1, toolCallsCount: 1, duration: 1 },
      };
    };

    const session = await createSession(options(store));
    const sessionIdForTest = session.sessionId;
    await session.send('write');
    for await (const _event of session.stream()) {
      // Drain.
    }

    expect(sideEffectSawToolStarted).toBe(true);
    expect((await store.read(session.sessionId)).events.map((event) => event.type)).toEqual([
      DurableEventType.SESSION_CREATED,
      DurableEventType.REQUEST_ACCEPTED,
      DurableEventType.INPUT_APPLIED,
      DurableEventType.REQUEST_STARTED,
      DurableEventType.TURN_STARTED,
      DurableEventType.TOOL_SCHEDULED,
      DurableEventType.PERMISSION_REQUESTED,
      DurableEventType.PERMISSION_RESOLVED,
      DurableEventType.TOOL_STARTED,
      DurableEventType.TOOL_COMPLETED,
      DurableEventType.TURN_COMPLETED,
      DurableEventType.REQUEST_COMPLETED,
    ]);
    await session.close();
  });

  it('does not cross the side-effect boundary when tool-start persistence fails', async () => {
    const { store } = createStore();
    const failingStore = new FailOnEventTypeStore(store, DurableEventType.TOOL_STARTED);
    let sideEffectRan = false;
    streamChat = async function* failedToolStart(_message, _context, loopOptions) {
      yield { type: 'turn_start', turn: 1, maxTurns: 10 };
      const lifecycle = loopOptions?.toolExecutionLifecycle;
      const invocation = await lifecycle?.onToolScheduled?.({
        toolCallId: ToolUseId('tool-call-1'),
        toolName: 'Write',
        input: {},
        sideEffect: 'non_idempotent',
        interruptBehavior: 'block',
      });
      if (!invocation) {
        throw new Error('Missing tool invocation lifecycle');
      }
      await invocation.onExecutionStarted?.({
        input: {},
        sideEffect: 'non_idempotent',
      });
      sideEffectRan = true;
      return {
        success: true,
        finalMessage: 'unexpected',
        metadata: { turnsCount: 1, toolCallsCount: 1, duration: 1 },
      };
    };

    const session = await createSession(options(failingStore));
    await session.send('write');
    const messages: AgentEvent[] = [];
    await expect(
      (async () => {
        for await (const event of session.stream()) {
          messages.push(event as AgentEvent);
        }
      })(),
    ).rejects.toThrow('Request execution and durable finalization both failed');

    expect(sideEffectRan).toBe(false);
    expect(messages.some((event) => event.type === 'error')).toBe(false);
    const durableTypes = (await store.read(session.sessionId)).events.map((event) => event.type);
    expect(durableTypes).toContain(DurableEventType.TOOL_SCHEDULED);
    expect(durableTypes).not.toContain(DurableEventType.TOOL_STARTED);
    expect(session.getDurableRecoveryPlan()?.action).toBe('resume_turn');
  });

  it('does not publish a terminal event or start another request when terminal persistence fails', async () => {
    const { store } = createStore();
    const failingStore = new FailOnEventTypeStore(store, DurableEventType.REQUEST_COMPLETED);
    const session = await createSession(options(failingStore));
    await session.send('complete durably');
    const output = session.stream();

    await expect(output.next()).resolves.toMatchObject({
      value: { type: 'turn_start' },
      done: false,
    });
    await expect(output.next()).resolves.toMatchObject({
      value: { type: 'turn_end' },
      done: false,
    });
    await expect(output.next()).rejects.toBeInstanceOf(DurableCommandOutcomeUnknownError);

    const durableTypes = (await store.read(session.sessionId)).events.map((event) => event.type);
    expect(durableTypes).not.toContain(DurableEventType.REQUEST_COMPLETED);
    expect(session.getDurableRecoveryPlan()?.action).toBe('resume_request');
    await expect(session.send('must wait for recovery')).rejects.toBeInstanceOf(
      DurableSessionRecoveryRequiredError,
    );
    await session.close();
  });

  it('resumes a durably accepted request without accepting it twice', async () => {
    const { root, store } = createStore();
    const sessionId = SessionId('unfinished-session');
    const requestId = RequestId('unfinished-request');
    const inputId = InputId('unfinished-input');
    const journal = await DurableSessionJournal.open(store, sessionId);
    await journal.commit({
      commandId: CommandId('command-create'),
      events: [
        {
          type: DurableEventType.SESSION_CREATED,
          data: { source: 'create' },
        },
      ],
    });
    await journal.commit({
      commandId: CommandId('command-request'),
      events: [
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId,
          data: {
            inputId,
            input: 'resume me',
            priority: 'next',
            maxTurns: 17,
            model: 'durable-model',
            context: {
              id: 'durable-context',
              environment: { RECOVERED: 'yes' },
            },
          },
        },
      ],
    });
    let observedMessage: UserMessageContent | undefined;
    let observedContext: unknown;
    let observedOptions: LoopOptions | undefined;
    streamChat = async function* recoveredStream(message, context, loopOptions) {
      observedMessage = message;
      observedContext = context;
      observedOptions = loopOptions;
      yield { type: 'turn_start', turn: 1, maxTurns: 17 };
      yield { type: 'turn_end', turn: 1, hasToolCalls: false };
      return {
        success: true,
        finalMessage: 'recovered',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 1 },
      };
    };

    const session = await resumeSession({
      ...options(store),
      persistSession: true,
      storagePath: root,
      sessionId,
      defaultContext: {
        id: 'replacement-context',
        environment: { RECOVERED: 'no' },
      },
    });

    const createdConfig = createAgent.mock.calls.at(-1)?.[0] as
      | { models?: Array<{ model?: string }> }
      | undefined;
    expect(createdConfig?.models?.[0]?.model).toBe('durable-model');
    expect(session.getPendingInputs()).toEqual([
      expect.objectContaining({
        inputId,
        content: 'resume me',
        targetRequestId: requestId,
      }),
    ]);
    for await (const _event of session.stream()) {
      // Drain the recovered request.
    }

    expect(observedMessage).toBe('resume me');
    expect(observedOptions?.maxTurns).toBe(17);
    expect(observedContext).toMatchObject({
      snapshot: {
        context: {
          id: 'durable-context',
          environment: { RECOVERED: 'yes' },
        },
      },
    });
    const events = (await store.read(sessionId)).events;
    expect(events.filter((event) => event.type === DurableEventType.REQUEST_ACCEPTED)).toHaveLength(
      1,
    );
    expect(events.find((event) => event.type === DurableEventType.REQUEST_STARTED)?.requestId).toBe(
      requestId,
    );
    expect(session.getDurableRecoveryPlan()?.action).toBe('none');
    await session.close();
  });

  it('allows only one concurrent resume to cross request_started', async () => {
    const { root, store } = createStore();
    const sessionId = SessionId('concurrent-recovery-session');
    const requestId = RequestId('concurrent-recovery-request');
    const inputId = InputId('concurrent-recovery-input');
    const journal = await DurableSessionJournal.open(store, sessionId);
    await journal.commit({
      commandId: CommandId('concurrent-bootstrap'),
      events: [
        {
          type: DurableEventType.SESSION_CREATED,
          data: { source: 'create' },
        },
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId,
          data: {
            inputId,
            input: 'execute once',
            priority: 'next',
            maxTurns: 20,
            model: 'test-model',
            context: {},
          },
        },
      ],
    });
    let modelCalls = 0;
    streamChat = async function* concurrentRecoveryStream() {
      modelCalls += 1;
      yield { type: 'turn_start', turn: 1, maxTurns: 20 };
      yield { type: 'turn_end', turn: 1, hasToolCalls: false };
      return {
        success: true,
        finalMessage: 'done',
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 1 },
      };
    };

    const [winner, loser] = await Promise.all([
      resumeSession({
        ...options(store),
        persistSession: true,
        storagePath: root,
        sessionId,
      }),
      resumeSession({
        ...options(store),
        persistSession: true,
        storagePath: root,
        sessionId,
      }),
    ]);
    const winnerStream = winner.stream();
    await expect(winnerStream.next()).resolves.toMatchObject({
      value: { type: 'turn_start' },
      done: false,
    });
    await expect(loser.stream().next()).rejects.toThrow(
      /already applied|already started|has not started/,
    );
    expect(loser.getPendingInputs()).toEqual([]);

    while (!(await winnerStream.next()).done) {
      // Drain the winning execution.
    }
    expect(modelCalls).toBe(1);
    expect(
      (await store.read(sessionId)).events.filter(
        (event) => event.type === DurableEventType.REQUEST_STARTED,
      ),
    ).toHaveLength(1);
    await winner.close();
    await loser.close();
  });

  it('restores multimodal content from an accepted durable request', async () => {
    const { root, store } = createStore();
    const sessionId = SessionId('multimodal-recovery-session');
    const requestId = RequestId('multimodal-recovery-request');
    const inputId = InputId('multimodal-recovery-input');
    const input: JsonValue = [
      { type: 'text', text: 'Inspect this image' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,recovery' },
      },
    ];
    const journal = await DurableSessionJournal.open(store, sessionId);
    await journal.commit({
      commandId: CommandId('multimodal-bootstrap'),
      events: [
        {
          type: DurableEventType.SESSION_CREATED,
          data: { source: 'create' },
        },
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId,
          data: {
            inputId,
            input,
            priority: 'next',
            maxTurns: 20,
            model: 'test-model',
            context: {},
          },
        },
      ],
    });

    const session = await resumeSession({
      ...options(store),
      persistSession: true,
      storagePath: root,
      sessionId,
    });

    expect(session.getPendingInputs()[0]?.content).toEqual(input);
    await session.abort();
    await session.close();
  });

  it('fails closed when an accepted request payload cannot be restored', async () => {
    const { root, store } = createStore();
    const sessionId = SessionId('invalid-recovery-session');
    const requestId = RequestId('invalid-recovery-request');
    const inputId = InputId('invalid-recovery-input');
    const journal = await DurableSessionJournal.open(store, sessionId);
    await journal.commit({
      commandId: CommandId('invalid-bootstrap'),
      events: [
        {
          type: DurableEventType.SESSION_CREATED,
          data: { source: 'create' },
        },
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId,
          data: {
            inputId,
            input: { unsupported: true },
            priority: 'next',
            maxTurns: 20,
            model: 'test-model',
            context: {},
          },
        },
      ],
    });

    await expect(
      resumeSession({
        ...options(store),
        persistSession: true,
        storagePath: root,
        sessionId,
      }),
    ).rejects.toBeInstanceOf(SessionDurableRecorderError);
  });

  it('fails closed when resuming a request that crossed the execution boundary', async () => {
    const { root, store } = createStore();
    const sessionId = SessionId('running-session');
    const requestId = RequestId('running-request');
    const inputId = InputId('running-input');
    const journal = await DurableSessionJournal.open(store, sessionId);
    await journal.commit({
      commandId: CommandId('command-bootstrap'),
      events: [
        {
          type: DurableEventType.SESSION_CREATED,
          data: { source: 'create' },
        },
        {
          type: DurableEventType.REQUEST_ACCEPTED,
          requestId,
          data: {
            inputId,
            input: 'do not replay me',
            priority: 'next',
          },
        },
        {
          type: DurableEventType.INPUT_APPLIED,
          requestId,
          data: {
            inputId,
            priority: 'next',
          },
        },
        {
          type: DurableEventType.REQUEST_STARTED,
          requestId,
          data: {},
        },
      ],
    });

    await expect(
      resumeSession({
        ...options(store),
        persistSession: true,
        storagePath: root,
        sessionId,
      }),
    ).rejects.toBeInstanceOf(DurableSessionRecoveryRequiredError);
  });

  it('durably interrupts a pending request before abort resolves', async () => {
    const { store } = createStore();
    const session = await createSession(options(store));
    await session.send('pending');

    await session.abort();

    expect(session.getDurableRecoveryPlan()?.action).toBe('none');
    expect((await store.read(session.sessionId)).events.map((event) => event.type)).toEqual([
      DurableEventType.SESSION_CREATED,
      DurableEventType.REQUEST_ACCEPTED,
      DurableEventType.REQUEST_INTERRUPTED,
    ]);

    await session.send('next');
    for await (const _event of session.stream()) {
      // Drain.
    }
    await session.close();
  });

  it('durably interrupts a pending request before cancelling its input', async () => {
    const { store } = createStore();
    const session = await createSession(options(store));
    const submission = await session.send('pending');
    if (submission.status !== 'started') {
      throw new Error('Expected started submission');
    }

    await expect(session.cancelInput(submission.inputId)).resolves.toBe(true);

    expect(session.getDurableRecoveryPlan()?.action).toBe('none');
    expect((await store.read(session.sessionId)).events.at(-1)?.type).toBe(
      DurableEventType.REQUEST_INTERRUPTED,
    );
    await session.close();
  });

  it('closes the inner stream and durably interrupts when a consumer stops early', async () => {
    const { store } = createStore();
    let innerClosed = false;
    streamChat = async function* interruptedByConsumer() {
      try {
        yield { type: 'turn_start', turn: 1, maxTurns: 10 };
        yield { type: 'content_delta', delta: 'partial' };
        return {
          success: true,
          finalMessage: 'unexpected',
          metadata: { turnsCount: 1, toolCallsCount: 0, duration: 1 },
        };
      } finally {
        innerClosed = true;
      }
    };
    const session = await createSession(options(store));
    await session.send('stop early');

    for await (const event of session.stream()) {
      expect(event.type).toBe('turn_start');
      break;
    }

    expect(innerClosed).toBe(true);
    expect(session.getDurableRecoveryPlan()?.action).toBe('none');
    expect(
      (await store.read(session.sessionId)).events.map((event) => event.type).slice(-2),
    ).toEqual([DurableEventType.TURN_ABORTED, DurableEventType.REQUEST_INTERRUPTED]);
    await session.close();
  });

  it('closes a pending durable request before closing the session', async () => {
    const { store } = createStore();
    const session = await createSession(options(store));
    await session.send('pending close');

    await session.close();

    expect(
      (await store.read(session.sessionId)).events.map((event) => event.type).slice(-2),
    ).toEqual([DurableEventType.REQUEST_INTERRUPTED, DurableEventType.SESSION_CLOSED]);
  });

  it('commits session closure once across concurrent close calls', async () => {
    const { store } = createStore();
    const session = await createSession(options(store));

    await Promise.all([session.close(), session.close()]);

    expect(
      (await store.read(session.sessionId)).events.filter(
        (event) => event.type === DurableEventType.SESSION_CLOSED,
      ),
    ).toHaveLength(1);
  });

  it('preserves the session-close reason when closing a running request', async () => {
    const { store } = createStore();
    streamChat = async function* interruptedByClose(_message, context) {
      yield { type: 'turn_start', turn: 1, maxTurns: 10 };
      const signal = (context as { signal?: AbortSignal }).signal;
      if (!signal) {
        throw new Error('Missing request signal');
      }
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        success: false,
        error: { type: 'aborted', message: 'closed' },
        metadata: { turnsCount: 1, toolCallsCount: 0, duration: 1 },
      };
    };
    const session = await createSession(options(store));
    await session.send('close while running');
    const output = session.stream();
    await expect(output.next()).resolves.toMatchObject({
      value: { type: 'turn_start' },
      done: false,
    });

    await session.close();
    for await (const _event of output) {
      // Drain cleanup after close.
    }

    const events = (await store.read(session.sessionId)).events;
    expect(
      events.find((event) => event.type === DurableEventType.REQUEST_INTERRUPTED)?.data,
    ).toMatchObject({ reason: 'session_close' });
    expect(events.at(-1)?.type).toBe(DurableEventType.SESSION_CLOSED);
  });

  it('accepts a queued later input durably when it becomes the next request', async () => {
    const { store } = createStore();
    const session = await createSession(options(store));
    await session.send('first');
    const queued = await session.send('second', { priority: 'later' });
    expect(queued.status).toBe('queued');

    for await (const _event of session.stream()) {
      // Drain first request.
    }
    for await (const _event of session.stream()) {
      // Drain promoted request.
    }

    const accepted = (await store.read(session.sessionId)).events.filter(
      (event) => event.type === DurableEventType.REQUEST_ACCEPTED,
    );
    expect(accepted).toHaveLength(2);
    expect(accepted[1]?.data).toMatchObject({
      input: 'second',
      priority: 'later',
    });
    await session.close();
  });

  it('does not close the source durable session after forkSession releases its local runtime', async () => {
    const { root, store } = createStore();
    const source = await createSession({
      ...options(store),
      persistSession: true,
      storagePath: root,
    });
    await source.send('source');
    for await (const _event of source.stream()) {
      // Drain.
    }

    const forked = await forkSession({
      ...options(store),
      persistSession: true,
      storagePath: root,
      sessionId: source.sessionId,
    });

    const sourceJournal = await DurableSessionJournal.open(store, source.sessionId);
    expect(sourceJournal.getProjection().status).toBe('open');
    expect(forked.getDurableProjection()?.created).toMatchObject({
      source: 'fork',
      parentSessionId: source.sessionId,
    });

    await forked.close();
    await source.close();
  });

  it('preserves the existing Session behavior when no durable Store is configured', async () => {
    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'test-model',
      persistSession: false,
    });

    expect(session.getDurableProjection()).toBeNull();
    expect(session.getDurableRecoveryPlan()).toBeNull();
    await session.close();
  });
});
