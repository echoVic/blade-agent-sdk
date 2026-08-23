import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommandId,
  EventId,
  EventSequence,
  InputId,
  ModelAttemptId,
  RequestId,
  SessionId,
  TurnId,
} from '../../../types/branded.js';
import type { JsonValue } from '../../../types/common.js';
import {
  DurableEventSequenceConflictError,
  type DurableEventStore,
  DurableEventStoreError,
} from '../DurableEventStore.js';
import {
  DurableCommandConflictError,
  DurableCommandOutcomeUnknownError,
  DurableSessionJournal,
  DurableSessionJournalError,
} from '../DurableSessionJournal.js';
import { DurableEventProjectionError } from '../DurableSessionProjector.js';
import { JsonlDurableEventStore } from '../JsonlDurableEventStore.js';
import type {
  DurableEventAppendOptions,
  DurableEventAppendResult,
  DurableEventDraft,
  DurableEventPage,
  DurableEventReadOptions,
} from '../types.js';
import { DurableEventType } from '../types.js';

const sessionId = SessionId('session-1');
const requestId = RequestId('request-1');
const initialInputId = InputId('input-1');

function sessionCreated() {
  return {
    type: DurableEventType.SESSION_CREATED,
    data: { source: 'create' as const },
  };
}

function requestAccepted(input: JsonValue = { task: 'build' }) {
  return {
    type: DurableEventType.REQUEST_ACCEPTED,
    requestId,
    data: {
      inputId: initialInputId,
      input,
      priority: 'next' as const,
    },
  };
}

class DelegatingStore implements DurableEventStore {
  constructor(readonly delegate: DurableEventStore) {}

  append(
    targetSessionId: SessionId,
    events: readonly DurableEventDraft[],
    options?: DurableEventAppendOptions,
  ): Promise<DurableEventAppendResult> {
    return this.delegate.append(targetSessionId, events, options);
  }

  read(targetSessionId: SessionId, options?: DurableEventReadOptions): Promise<DurableEventPage> {
    return this.delegate.read(targetSessionId, options);
  }

  getHeadSequence(targetSessionId: SessionId) {
    return this.delegate.getHeadSequence(targetSessionId);
  }
}

class FailAfterCommitStore extends DelegatingStore {
  private shouldFail = true;

  override async append(
    targetSessionId: SessionId,
    events: readonly DurableEventDraft[],
    options?: DurableEventAppendOptions,
  ): Promise<DurableEventAppendResult> {
    const result = await super.append(targetSessionId, events, options);
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new DurableEventStoreError(
        'DURABLE_EVENT_WRITE_FAILED',
        'Injected failure after commit',
      );
    }
    return result;
  }
}

class FailBeforeCommitStore extends DelegatingStore {
  appendCalls = 0;

  override async append(): Promise<DurableEventAppendResult> {
    this.appendCalls += 1;
    throw new DurableEventStoreError(
      'DURABLE_EVENT_WRITE_FAILED',
      'Injected failure before commit',
    );
  }
}

class InvalidCommitResultStore extends DelegatingStore {
  private shouldCorrupt = true;

  override async append(
    targetSessionId: SessionId,
    events: readonly DurableEventDraft[],
    options?: DurableEventAppendOptions,
  ): Promise<DurableEventAppendResult> {
    const result = await super.append(targetSessionId, events, options);
    if (!this.shouldCorrupt) {
      return result;
    }
    this.shouldCorrupt = false;
    return {
      ...result,
      events: [],
    };
  }
}

class AlwaysConflictStore extends DelegatingStore {
  appendCalls = 0;

  override async append(
    _targetSessionId: SessionId,
    _events: readonly DurableEventDraft[],
    options?: DurableEventAppendOptions,
  ): Promise<DurableEventAppendResult> {
    this.appendCalls += 1;
    throw new DurableEventSequenceConflictError(
      options?.expectedLastSequence ?? null,
      EventSequence(999),
    );
  }
}

class InvalidPageStore extends DelegatingStore {
  override async read(): Promise<DurableEventPage> {
    return {
      events: [],
      headSequence: EventSequence(1),
      nextCursor: null,
      hasMore: true,
    };
  }
}

describe('DurableSessionJournal', () => {
  let storageRoot: string;
  let nextEventId: number;
  let store: JsonlDurableEventStore;

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), 'durable-session-journal-'));
    nextEventId = 0;
    store = new JsonlDurableEventStore(storageRoot, {
      clock: () => new Date('2026-08-22T12:00:00.000Z'),
      eventIdFactory: () => EventId(`event-${++nextEventId}`),
    });
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('commits commands with CAS and stamps every event with the command ID', async () => {
    const journal = await DurableSessionJournal.open(store, sessionId);
    const created = await journal.commit({
      commandId: CommandId('command-create'),
      events: [sessionCreated()],
    });
    const accepted = await journal.commit({
      commandId: CommandId('command-request'),
      events: [requestAccepted()],
    });

    expect(created).toMatchObject({
      status: 'committed',
      previousSequence: null,
      lastSequence: 1,
    });
    expect(accepted).toMatchObject({
      status: 'committed',
      previousSequence: 1,
      lastSequence: 2,
    });
    expect((await store.read(sessionId)).events.map((event) => event.commandId)).toEqual([
      'command-create',
      'command-request',
    ]);
    expect(journal.getProjection().activeRequest).toMatchObject({
      requestId,
      commandId: 'command-request',
      status: 'accepted',
    });
  });

  it('commits a multi-event lifecycle transition as one idempotent command', async () => {
    const journal = await DurableSessionJournal.open(store, sessionId);
    const result = await journal.commit({
      commandId: CommandId('command-bootstrap'),
      events: [
        sessionCreated(),
        requestAccepted(),
        {
          type: DurableEventType.REQUEST_STARTED,
          requestId,
          data: {},
        },
      ],
    });

    expect(result.events).toHaveLength(3);
    expect(result.events.every((event) => event.commandId === 'command-bootstrap')).toBe(true);
    expect(journal.getProjection().activeRequest?.status).toBe('running');
    expect(
      (
        await journal.commit({
          commandId: CommandId('command-bootstrap'),
          events: [
            sessionCreated(),
            requestAccepted(),
            {
              type: DurableEventType.REQUEST_STARTED,
              requestId,
              data: {},
            },
          ],
        })
      ).status,
    ).toBe('replayed');
  });

  it('replays an identical command without appending duplicate events', async () => {
    const journal = await DurableSessionJournal.open(store, sessionId);
    const command = {
      commandId: CommandId('command-create'),
      events: [sessionCreated()],
    } as const;

    await journal.commit(command);
    const replayed = await journal.commit(command);

    expect(replayed.status).toBe('replayed');
    expect(replayed.events).toHaveLength(1);
    const indexed = journal.getCommandEvents(command.commandId);
    expect(indexed).toMatchObject([
      {
        type: DurableEventType.SESSION_CREATED,
        commandId: command.commandId,
      },
    ]);
    if (indexed) {
      (indexed[0] as { data: { source?: string } }).data.source = 'fork';
    }
    expect(journal.getCommandEvents(command.commandId)?.[0]?.data).toEqual({
      source: 'create',
    });
    expect(journal.getCommandEvents(CommandId('missing-command'))).toBeNull();
    expect(await store.getHeadSequence(sessionId)).toBe(1);
  });

  it('matches semantically identical JSON regardless of object key order', async () => {
    const journal = await DurableSessionJournal.open(store, sessionId);
    await journal.commit({
      commandId: CommandId('command-create'),
      events: [sessionCreated()],
    });
    await journal.commit({
      commandId: CommandId('command-request'),
      events: [requestAccepted({ first: 1, second: 2 })],
    });

    const replayed = await journal.commit({
      commandId: CommandId('command-request'),
      events: [requestAccepted({ second: 2, first: 1 })],
    });

    expect(replayed.status).toBe('replayed');
    expect(await store.getHeadSequence(sessionId)).toBe(2);
  });

  it('rejects reuse of a command ID with different events', async () => {
    const journal = await DurableSessionJournal.open(store, sessionId);
    await journal.commit({
      commandId: CommandId('command-create'),
      events: [sessionCreated()],
    });

    await expect(
      journal.commit({
        commandId: CommandId('command-create'),
        events: [
          {
            type: DurableEventType.SESSION_CREATED,
            data: { source: 'resume' },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(DurableCommandConflictError);
    expect(await store.getHeadSequence(sessionId)).toBe(1);
  });

  it('rejects invalid transitions before writing them', async () => {
    const journal = await DurableSessionJournal.open(store, sessionId);

    await expect(
      journal.commit({
        commandId: CommandId('command-request'),
        events: [requestAccepted()],
      }),
    ).rejects.toBeInstanceOf(DurableEventProjectionError);
    expect(await store.getHeadSequence(sessionId)).toBeNull();
  });

  it('retries a different command after refreshing a CAS conflict', async () => {
    const bootstrap = await DurableSessionJournal.open(store, sessionId);
    await bootstrap.commit({
      commandId: CommandId('command-create'),
      events: [sessionCreated()],
    });
    await bootstrap.commit({
      commandId: CommandId('command-request'),
      events: [requestAccepted()],
    });

    const first = await DurableSessionJournal.open(store, sessionId);
    const second = await DurableSessionJournal.open(store, sessionId);
    await first.commit({
      commandId: CommandId('command-input'),
      events: [
        {
          type: DurableEventType.INPUT_APPLIED,
          requestId,
          data: {
            inputId: initialInputId,
            priority: 'next',
          },
        },
      ],
    });
    const started = await second.commit({
      commandId: CommandId('command-start'),
      events: [
        {
          type: DurableEventType.REQUEST_STARTED,
          requestId,
          data: {},
        },
      ],
    });

    expect(started).toMatchObject({
      status: 'committed',
      previousSequence: 3,
      lastSequence: 4,
    });
    expect(second.getProjection().activeRequest?.status).toBe('running');
  });

  it('does not rebase a state-derived command when its expected head is stale', async () => {
    const bootstrap = await DurableSessionJournal.open(store, sessionId);
    await bootstrap.commit({
      commandId: CommandId('command-create'),
      events: [sessionCreated()],
    });
    await bootstrap.commit({
      commandId: CommandId('command-request'),
      events: [requestAccepted()],
    });

    const first = await DurableSessionJournal.open(store, sessionId);
    const second = await DurableSessionJournal.open(store, sessionId);
    await first.commit({
      commandId: CommandId('command-input'),
      events: [
        {
          type: DurableEventType.INPUT_APPLIED,
          requestId,
          data: {
            inputId: initialInputId,
            priority: 'next',
          },
        },
      ],
    });

    await expect(
      second.commit(
        {
          commandId: CommandId('command-start'),
          events: [
            {
              type: DurableEventType.REQUEST_STARTED,
              requestId,
              data: {},
            },
          ],
        },
        { expectedHeadSequence: EventSequence(2) },
      ),
    ).rejects.toBeInstanceOf(DurableEventSequenceConflictError);
    expect(second.getProjection().activeRequest?.status).toBe('accepted');
    expect(await store.getHeadSequence(sessionId)).toBe(3);
  });

  it('checks an expected head against commits made through the same journal', async () => {
    const journal = await DurableSessionJournal.open(store, sessionId);
    await journal.commit({
      commandId: CommandId('command-create'),
      events: [sessionCreated()],
    });
    await journal.commit({
      commandId: CommandId('command-request'),
      events: [requestAccepted()],
    });
    const observedHead = journal.getProjection().headSequence;
    await journal.commit({
      commandId: CommandId('command-input'),
      events: [
        {
          type: DurableEventType.INPUT_APPLIED,
          requestId,
          data: {
            inputId: initialInputId,
            priority: 'next',
          },
        },
      ],
    });

    await expect(
      journal.commit(
        {
          commandId: CommandId('command-start'),
          events: [
            {
              type: DurableEventType.REQUEST_STARTED,
              requestId,
              data: {},
            },
          ],
        },
        { expectedHeadSequence: observedHead },
      ),
    ).rejects.toBeInstanceOf(DurableEventSequenceConflictError);
    expect(await store.getHeadSequence(sessionId)).toBe(3);
  });

  it('reconciles concurrent delivery of the same command', async () => {
    const bootstrap = await DurableSessionJournal.open(store, sessionId);
    await bootstrap.commit({
      commandId: CommandId('command-create'),
      events: [sessionCreated()],
    });
    await bootstrap.commit({
      commandId: CommandId('command-request'),
      events: [requestAccepted()],
    });

    const first = await DurableSessionJournal.open(store, sessionId);
    const second = await DurableSessionJournal.open(store, sessionId);
    const command = {
      commandId: CommandId('command-start'),
      events: [
        {
          type: DurableEventType.REQUEST_STARTED,
          requestId,
          data: {},
        },
      ],
    } as const;
    const results = await Promise.all([first.commit(command), second.commit(command)]);

    expect(results.map((result) => result.status).sort()).toEqual(['committed', 'reconciled']);
    expect(await store.getHeadSequence(sessionId)).toBe(3);
  });

  it('serializes concurrent commands submitted through one journal', async () => {
    const journal = await DurableSessionJournal.open(store, sessionId);
    await journal.commit({
      commandId: CommandId('command-create'),
      events: [sessionCreated()],
    });
    await journal.commit({
      commandId: CommandId('command-request'),
      events: [requestAccepted()],
    });

    const [applied, started] = await Promise.all([
      journal.commit({
        commandId: CommandId('command-input'),
        events: [
          {
            type: DurableEventType.INPUT_APPLIED,
            requestId,
            data: {
              inputId: initialInputId,
              priority: 'next',
            },
          },
        ],
      }),
      journal.commit({
        commandId: CommandId('command-start'),
        events: [
          {
            type: DurableEventType.REQUEST_STARTED,
            requestId,
            data: {},
          },
        ],
      }),
    ]);

    expect(applied.status).toBe('committed');
    expect(started.status).toBe('committed');
    expect(await store.getHeadSequence(sessionId)).toBe(4);
  });

  it('reconciles a write failure when the command is visible after reload', async () => {
    const journal = await DurableSessionJournal.open(new FailAfterCommitStore(store), sessionId);

    const result = await journal.commit({
      commandId: CommandId('command-create'),
      events: [sessionCreated()],
    });

    expect(result.status).toBe('reconciled');
    expect(result.lastSequence).toBe(1);
    expect(journal.getProjection().status).toBe('open');
  });

  it('reports an unknown outcome instead of retrying when a failed write is absent', async () => {
    const failingStore = new FailBeforeCommitStore(store);
    const journal = await DurableSessionJournal.open(failingStore, sessionId);

    await expect(
      journal.commit({
        commandId: CommandId('command-create'),
        events: [sessionCreated()],
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_COMMAND_OUTCOME_UNKNOWN',
      commandId: 'command-create',
    });
    expect(journal.getUncertainCommandId()).toBe('command-create');
    expect(await store.getHeadSequence(sessionId)).toBeNull();

    await expect(
      journal.commit({
        commandId: CommandId('command-after-unknown'),
        events: [sessionCreated()],
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_COMMAND_OUTCOME_UNKNOWN',
      commandId: 'command-create',
    });
    expect(failingStore.appendCalls).toBe(1);

    await expect(
      journal.commit({
        commandId: CommandId('command-create'),
        events: [sessionCreated()],
      }),
    ).rejects.toMatchObject({
      code: 'DURABLE_COMMAND_OUTCOME_UNKNOWN',
      commandId: 'command-create',
    });
    expect(failingStore.appendCalls).toBe(1);

    await store.append(
      sessionId,
      [
        {
          ...sessionCreated(),
          commandId: CommandId('command-create'),
        },
      ],
      {
        expectedLastSequence: null,
      },
    );
    const reconciled = await journal.commit({
      commandId: CommandId('command-create'),
      events: [sessionCreated()],
    });
    expect(reconciled.status).toBe('reconciled');
    expect(journal.getUncertainCommandId()).toBeNull();
  });

  it('reconciles an invalid append response against canonical storage', async () => {
    const journal = await DurableSessionJournal.open(
      new InvalidCommitResultStore(store),
      sessionId,
    );

    const result = await journal.commit({
      commandId: CommandId('command-create'),
      events: [sessionCreated()],
    });

    expect(result.status).toBe('reconciled');
    expect(result.events).toHaveLength(1);
    expect(journal.getProjection().status).toBe('open');
  });

  it('rebuilds projection and command indexes across cursor pages', async () => {
    const journal = await DurableSessionJournal.open(store, sessionId);
    await journal.commit({
      commandId: CommandId('command-create'),
      events: [sessionCreated()],
    });
    await journal.commit({
      commandId: CommandId('command-request'),
      events: [requestAccepted()],
    });
    await journal.commit({
      commandId: CommandId('command-start'),
      events: [
        {
          type: DurableEventType.REQUEST_STARTED,
          requestId,
          data: {},
        },
      ],
    });

    const reopened = await DurableSessionJournal.open(store, sessionId, {
      pageSize: 1,
    });
    const replayed = await reopened.commit({
      commandId: CommandId('command-start'),
      events: [
        {
          type: DurableEventType.REQUEST_STARTED,
          requestId,
          data: {},
        },
      ],
    });

    expect(reopened.getProjection().headSequence).toBe(3);
    expect(reopened.getProjection().activeRequest?.status).toBe('running');
    expect(replayed.status).toBe('replayed');
  });

  it('includes modelAttemptId when validating command replay identity', async () => {
    const journal = await DurableSessionJournal.open(store, sessionId);
    const turnId = TurnId('turn-model-replay');
    await journal.commit({
      commandId: CommandId('command-bootstrap-model'),
      events: [
        sessionCreated(),
        requestAccepted(),
        {
          type: DurableEventType.REQUEST_STARTED,
          requestId,
          data: {},
        },
        {
          type: DurableEventType.TURN_STARTED,
          requestId,
          turnId,
          data: { turn: 1 },
        },
      ],
    });
    const commandId = CommandId('command-model-start');
    await journal.commit({
      commandId,
      events: [
        {
          type: DurableEventType.MODEL_REQUEST_STARTED,
          requestId,
          turnId,
          modelAttemptId: ModelAttemptId('model-attempt-original'),
          data: { model: 'test-model', streaming: true },
        },
      ],
    });

    await expect(
      journal.commit({
        commandId,
        events: [
          {
            type: DurableEventType.MODEL_REQUEST_STARTED,
            requestId,
            turnId,
            modelAttemptId: ModelAttemptId('model-attempt-original'),
            data: { model: 'test-model', streaming: true },
          },
        ],
      }),
    ).resolves.toMatchObject({
      status: 'replayed',
    });
    await expect(
      journal.commit({
        commandId,
        events: [
          {
            type: DurableEventType.MODEL_REQUEST_STARTED,
            requestId,
            turnId,
            modelAttemptId: ModelAttemptId('model-attempt-different'),
            data: { model: 'test-model', streaming: true },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(DurableCommandConflictError);
  });

  it('bounds CAS retries for competing commands', async () => {
    const bootstrap = await DurableSessionJournal.open(store, sessionId);
    await bootstrap.commit({
      commandId: CommandId('command-create'),
      events: [sessionCreated()],
    });
    const conflictingStore = new AlwaysConflictStore(store);
    const journal = await DurableSessionJournal.open(conflictingStore, sessionId, {
      maxConflictRetries: 2,
    });

    await expect(
      journal.commit({
        commandId: CommandId('command-request'),
        events: [requestAccepted()],
      }),
    ).rejects.toBeInstanceOf(DurableEventSequenceConflictError);
    expect(conflictingStore.appendCalls).toBe(3);
  });

  it('rejects non-advancing or inconsistent Store pages', async () => {
    await expect(
      DurableSessionJournal.open(new InvalidPageStore(store), sessionId),
    ).rejects.toMatchObject({
      code: 'DURABLE_JOURNAL_INVALID_PAGE',
    });
  });

  it('rejects a command ID split across non-contiguous event ranges', async () => {
    await store.append(sessionId, [
      {
        ...sessionCreated(),
        commandId: CommandId('command-reused'),
      },
      {
        ...requestAccepted(),
        commandId: CommandId('command-request'),
      },
      {
        type: DurableEventType.INPUT_APPLIED,
        requestId,
        commandId: CommandId('command-reused'),
        data: {
          inputId: initialInputId,
          priority: 'next',
        },
      },
    ]);

    await expect(DurableSessionJournal.open(store, sessionId)).rejects.toMatchObject({
      code: 'DURABLE_COMMAND_CONFLICT',
    });
  });

  it.each([
    { pageSize: 0, maxConflictRetries: 3 },
    { pageSize: 1001, maxConflictRetries: 3 },
    { pageSize: 10, maxConflictRetries: -1 },
    { pageSize: 10, maxConflictRetries: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid journal options %#', async (options) => {
    await expect(DurableSessionJournal.open(store, sessionId, options)).rejects.toBeInstanceOf(
      DurableSessionJournalError,
    );
  });

  it('rejects empty commands and blank command IDs', async () => {
    const journal = await DurableSessionJournal.open(store, sessionId);

    await expect(
      journal.commit({
        commandId: CommandId('command-empty'),
        events: [],
      }),
    ).rejects.toMatchObject({ code: 'DURABLE_COMMAND_INVALID' });
    await expect(
      journal.commit({
        commandId: CommandId('   '),
        events: [sessionCreated()],
      }),
    ).rejects.toMatchObject({ code: 'DURABLE_COMMAND_INVALID' });
  });

  it('returns defensive events when replaying a command', async () => {
    const journal = await DurableSessionJournal.open(store, sessionId);
    const command = {
      commandId: CommandId('command-create'),
      events: [sessionCreated()],
    } as const;
    await journal.commit(command);
    const replayed = await journal.commit(command);
    (replayed.events[0]?.data as { source: string }).source = 'mutated';

    expect((await store.read(sessionId)).events[0]?.data).toEqual({
      source: 'create',
    });
  });

  it('does not expose its command index through committed results', async () => {
    const journal = await DurableSessionJournal.open(store, sessionId);
    const command = {
      commandId: CommandId('command-create'),
      events: [sessionCreated()],
    } as const;
    const committed = await journal.commit(command);
    (committed.events[0]?.data as { source: string }).source = 'mutated';

    const replayed = await journal.commit(command);
    expect(replayed.status).toBe('replayed');
    expect(replayed.events[0]?.data).toEqual({ source: 'create' });
  });

  it('surfaces typed unknown-outcome errors', () => {
    expect(new DurableCommandOutcomeUnknownError(CommandId('command-1'))).toMatchObject({
      code: 'DURABLE_COMMAND_OUTCOME_UNKNOWN',
      commandId: 'command-1',
    });
  });
});
