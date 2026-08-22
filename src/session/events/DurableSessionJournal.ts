import { SdkError } from '../../errors/SdkError.js';
import { type CommandId, EventSequence, type SessionId } from '../../types/branded.js';
import { DurableEventSequenceConflictError, type DurableEventStore } from './DurableEventStore.js';
import {
  type DurableSessionProjection,
  DurableSessionProjector,
  type DurableSessionRecoveryPlan,
} from './DurableSessionProjector.js';
import { parseDurableEventDraft } from './schemas.js';
import type {
  DurableEventAppendResult,
  DurableEventDraft,
  DurableEventEnvelope,
  DurableEventPage,
  DurableEventType,
} from './types.js';

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_MAX_CONFLICT_RETRIES = 3;

type WithoutCommandId<T> = T extends unknown ? Omit<T, 'commandId'> : never;

export type DurableCommandEventDraft<TType extends DurableEventType = DurableEventType> =
  WithoutCommandId<DurableEventDraft<TType>>;

export interface DurableSessionCommand {
  readonly commandId: CommandId;
  readonly events: readonly DurableCommandEventDraft[];
}

export interface DurableCommandCommitOptions {
  /**
   * Requires the Journal to still be at this exact head before committing.
   * Commands derived from a state snapshot should always set this precondition.
   */
  readonly expectedHeadSequence?: EventSequence | null;
}

export type DurableCommandCommitStatus = 'committed' | 'replayed' | 'reconciled';

export interface DurableCommandCommitResult extends DurableEventAppendResult {
  readonly status: DurableCommandCommitStatus;
  readonly commandId: CommandId;
}

export interface DurableSessionJournalOptions {
  readonly pageSize?: number;
  readonly maxConflictRetries?: number;
}

export type DurableSessionJournalErrorCode =
  | 'DURABLE_COMMAND_CONFLICT'
  | 'DURABLE_COMMAND_INVALID'
  | 'DURABLE_COMMAND_OUTCOME_UNKNOWN'
  | 'DURABLE_JOURNAL_INVALID_COMMIT'
  | 'DURABLE_JOURNAL_INVALID_PAGE';

export class DurableSessionJournalError extends SdkError {
  // biome-ignore lint/complexity/noUselessConstructor: narrows the public error-code contract
  constructor(
    code: DurableSessionJournalErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(code, message, options);
  }
}

export class DurableCommandConflictError extends DurableSessionJournalError {
  readonly commandId: CommandId;
  readonly existingEvents: readonly DurableEventEnvelope[];

  constructor(commandId: CommandId, existingEvents: readonly DurableEventEnvelope[]) {
    super(
      'DURABLE_COMMAND_CONFLICT',
      `Durable command ${commandId} was already committed with different events`,
    );
    this.commandId = commandId;
    this.existingEvents = structuredClone(existingEvents);
  }
}

export class DurableCommandOutcomeUnknownError extends DurableSessionJournalError {
  readonly commandId: CommandId;

  constructor(commandId: CommandId, options?: { cause?: unknown }) {
    super(
      'DURABLE_COMMAND_OUTCOME_UNKNOWN',
      `The commit outcome for durable command ${commandId} is unknown`,
      options,
    );
    this.commandId = commandId;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function comparableDraft(
  draft: DurableEventDraft,
  occurredAt: string | undefined,
): Record<string, unknown> {
  return {
    type: draft.type,
    data: draft.data,
    commandId: draft.commandId,
    ...('requestId' in draft ? { requestId: draft.requestId } : {}),
    ...('turnId' in draft ? { turnId: draft.turnId } : {}),
    ...('toolAttemptId' in draft ? { toolAttemptId: draft.toolAttemptId } : {}),
    ...(draft.causationEventId ? { causationEventId: draft.causationEventId } : {}),
    ...(occurredAt ? { occurredAt } : {}),
  };
}

function commandMatches(
  existingEvents: readonly DurableEventEnvelope[],
  drafts: readonly DurableEventDraft[],
): boolean {
  if (existingEvents.length !== drafts.length) {
    return false;
  }
  return drafts.every((draft, index) => {
    const existing = existingEvents[index];
    if (!existing) {
      return false;
    }
    const existingComparable = comparableDraft(
      existing,
      draft.occurredAt ? existing.occurredAt : undefined,
    );
    return (
      canonicalJson(existingComparable) === canonicalJson(comparableDraft(draft, draft.occurredAt))
    );
  });
}

function resultFromExisting(
  status: Exclude<DurableCommandCommitStatus, 'committed'>,
  commandId: CommandId,
  events: readonly DurableEventEnvelope[],
): DurableCommandCommitResult {
  const first = events[0];
  const last = events.at(-1);
  if (!first || !last) {
    throw new DurableSessionJournalError(
      'DURABLE_COMMAND_INVALID',
      `Durable command ${commandId} has no persisted events`,
    );
  }
  return {
    status,
    commandId,
    events: structuredClone(events),
    previousSequence: first.sequence === 1 ? null : EventSequence(Number(first.sequence) - 1),
    lastSequence: last.sequence,
  };
}

export class DurableSessionJournal {
  private projector = new DurableSessionProjector();
  private commandEvents = new Map<CommandId, DurableEventEnvelope[]>();
  private operationTail: Promise<void> = Promise.resolve();
  private uncertainCommand: {
    commandId: CommandId;
    cause: unknown;
  } | null = null;

  private constructor(
    private readonly store: DurableEventStore,
    readonly sessionId: SessionId,
    private readonly pageSize: number,
    private readonly maxConflictRetries: number,
  ) {}

  static async open(
    store: DurableEventStore,
    sessionId: SessionId,
    options: DurableSessionJournalOptions = {},
  ): Promise<DurableSessionJournal> {
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    const maxConflictRetries = options.maxConflictRetries ?? DEFAULT_MAX_CONFLICT_RETRIES;
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > 1000) {
      throw new DurableSessionJournalError(
        'DURABLE_COMMAND_INVALID',
        'Durable Session journal pageSize must be between 1 and 1000',
      );
    }
    if (!Number.isSafeInteger(maxConflictRetries) || maxConflictRetries < 0) {
      throw new DurableSessionJournalError(
        'DURABLE_COMMAND_INVALID',
        'Durable Session journal maxConflictRetries must be a non-negative safe integer',
      );
    }

    const journal = new DurableSessionJournal(store, sessionId, pageSize, maxConflictRetries);
    await journal.reload();
    return journal;
  }

  getProjection(): DurableSessionProjection {
    return this.projector.snapshot();
  }

  getRecoveryPlan(): DurableSessionRecoveryPlan {
    return this.projector.recoveryPlan();
  }

  getUncertainCommandId(): CommandId | null {
    return this.uncertainCommand?.commandId ?? null;
  }

  /** Returns a defensive snapshot of one already-indexed command. */
  getCommandEvents(commandId: CommandId): readonly DurableEventEnvelope[] | null {
    const events = this.commandEvents.get(commandId);
    return events ? structuredClone(events) : null;
  }

  refresh(): Promise<DurableSessionProjection> {
    return this.runExclusive(async () => {
      await this.reload();
      return this.projector.snapshot();
    });
  }

  commit(
    command: DurableSessionCommand,
    options: DurableCommandCommitOptions = {},
  ): Promise<DurableCommandCommitResult> {
    return this.runExclusive(() => this.commitExclusive(command, options));
  }

  private async commitExclusive(
    command: DurableSessionCommand,
    options: DurableCommandCommitOptions,
  ): Promise<DurableCommandCommitResult> {
    const drafts = this.parseCommand(command);
    if (this.uncertainCommand) {
      if (this.uncertainCommand.commandId !== command.commandId) {
        throw new DurableCommandOutcomeUnknownError(this.uncertainCommand.commandId, {
          cause: this.uncertainCommand.cause,
        });
      }
      await this.reloadForUnknownOutcome(
        this.uncertainCommand.commandId,
        this.uncertainCommand.cause,
      );
      const reconciled = this.commandEvents.get(command.commandId);
      if (!reconciled) {
        throw new DurableCommandOutcomeUnknownError(command.commandId, {
          cause: this.uncertainCommand.cause,
        });
      }
      const result = this.resolveExistingCommand(
        'reconciled',
        command.commandId,
        reconciled,
        drafts,
      );
      this.uncertainCommand = null;
      return result;
    }
    const existing = this.commandEvents.get(command.commandId);
    if (existing) {
      return this.resolveExistingCommand('replayed', command.commandId, existing, drafts);
    }
    const currentHeadSequence = this.projector.snapshot().headSequence;
    if (
      options.expectedHeadSequence !== undefined
      && currentHeadSequence !== options.expectedHeadSequence
    ) {
      throw new DurableEventSequenceConflictError(
        options.expectedHeadSequence,
        currentHeadSequence,
      );
    }

    let conflicts = 0;
    while (true) {
      this.projector.preview(this.sessionId, drafts);
      try {
        const expectedLastSequence = this.projector.snapshot().headSequence;
        const result = await this.store.append(this.sessionId, drafts, {
          expectedLastSequence,
        });
        try {
          this.validateCommitResult(result, drafts, expectedLastSequence);
          const committedEvents = structuredClone(result.events);
          this.projector.apply(committedEvents);
          this.indexCommandEvents(committedEvents);
          return {
            ...result,
            events: structuredClone(committedEvents),
            status: 'committed',
            commandId: command.commandId,
          };
        } catch (commitError) {
          return this.reconcileUnknownOutcome(command.commandId, drafts, commitError);
        }
      } catch (error) {
        if (
          error instanceof DurableEventSequenceConflictError ||
          isErrorCode(error, 'DURABLE_EVENT_SEQUENCE_CONFLICT')
        ) {
          await this.reload();
          const committed = this.commandEvents.get(command.commandId);
          if (committed) {
            return this.resolveExistingCommand('reconciled', command.commandId, committed, drafts);
          }
          if (
            options.expectedHeadSequence !== undefined
            || conflicts >= this.maxConflictRetries
          ) {
            throw error;
          }
          conflicts += 1;
          continue;
        }

        if (isErrorCode(error, 'DURABLE_EVENT_WRITE_FAILED')) {
          return this.reconcileUnknownOutcome(command.commandId, drafts, error);
        }
        throw error;
      }
    }
  }

  private parseCommand(command: DurableSessionCommand): DurableEventDraft[] {
    if (command.commandId.trim() === '' || command.events.length === 0) {
      throw new DurableSessionJournalError(
        'DURABLE_COMMAND_INVALID',
        'A durable command requires a non-empty commandId and at least one event',
      );
    }
    try {
      return command.events.map((event) =>
        parseDurableEventDraft({
          ...event,
          commandId: command.commandId,
        }),
      );
    } catch (cause) {
      throw new DurableSessionJournalError(
        'DURABLE_COMMAND_INVALID',
        `Durable command ${command.commandId} contains an invalid event`,
        { cause },
      );
    }
  }

  private resolveExistingCommand(
    status: Exclude<DurableCommandCommitStatus, 'committed'>,
    commandId: CommandId,
    existing: readonly DurableEventEnvelope[],
    drafts: readonly DurableEventDraft[],
  ): DurableCommandCommitResult {
    if (!commandMatches(existing, drafts)) {
      throw new DurableCommandConflictError(commandId, existing);
    }
    return resultFromExisting(status, commandId, existing);
  }

  private validateCommitResult(
    result: DurableEventAppendResult,
    drafts: readonly DurableEventDraft[],
    expectedLastSequence: EventSequence | null,
  ): void {
    const last = result.events.at(-1);
    if (
      result.previousSequence !== expectedLastSequence ||
      !last ||
      result.lastSequence !== last.sequence ||
      !commandMatches(result.events, drafts)
    ) {
      throw new DurableSessionJournalError(
        'DURABLE_JOURNAL_INVALID_COMMIT',
        'Durable Event Store returned a commit result that does not match the command',
      );
    }
  }

  private async reconcileUnknownOutcome(
    commandId: CommandId,
    drafts: readonly DurableEventDraft[],
    writeError: unknown,
  ): Promise<DurableCommandCommitResult> {
    await this.reloadForUnknownOutcome(commandId, writeError);
    const committed = this.commandEvents.get(commandId);
    if (committed) {
      return this.resolveExistingCommand('reconciled', commandId, committed, drafts);
    }
    this.uncertainCommand = { commandId, cause: writeError };
    throw new DurableCommandOutcomeUnknownError(commandId, { cause: writeError });
  }

  private async reloadForUnknownOutcome(commandId: CommandId, writeError: unknown): Promise<void> {
    try {
      await this.reload();
    } catch (reloadError) {
      const cause = new AggregateError(
        [writeError, reloadError],
        'The write failed and durable state could not be reloaded',
      );
      this.uncertainCommand = {
        commandId,
        cause,
      };
      throw new DurableCommandOutcomeUnknownError(commandId, { cause });
    }
  }

  private async reload(): Promise<void> {
    const projector = new DurableSessionProjector();
    const commandEvents = new Map<CommandId, DurableEventEnvelope[]>();
    const closedCommands = new Set<CommandId>();
    let activeCommandId: CommandId | undefined;
    let after: EventSequence | undefined;

    while (true) {
      const page = await this.store.read(this.sessionId, {
        ...(after ? { after } : {}),
        limit: this.pageSize,
      });
      this.validateReadPage(page, after);
      projector.apply(page.events);

      for (const event of page.events) {
        if (!event.commandId) {
          if (activeCommandId) {
            closedCommands.add(activeCommandId);
            activeCommandId = undefined;
          }
          continue;
        }
        if (activeCommandId !== event.commandId) {
          if (activeCommandId) {
            closedCommands.add(activeCommandId);
          }
          if (closedCommands.has(event.commandId)) {
            throw new DurableSessionJournalError(
              'DURABLE_COMMAND_CONFLICT',
              `Durable command ${event.commandId} appears in non-contiguous event ranges`,
            );
          }
          activeCommandId = event.commandId;
        }
        const events = commandEvents.get(event.commandId) ?? [];
        events.push(event);
        commandEvents.set(event.commandId, events);
      }

      if (!page.hasMore) {
        break;
      }
      if (page.events.length === 0 || page.nextCursor === null || page.nextCursor === after) {
        throw new DurableSessionJournalError(
          'DURABLE_JOURNAL_INVALID_PAGE',
          'Durable Event Store returned a non-advancing page',
        );
      }
      after = page.nextCursor;
    }

    this.projector = projector;
    this.commandEvents = commandEvents;
  }

  private validateReadPage(page: DurableEventPage, after: EventSequence | undefined): void {
    const last = page.events.at(-1);
    if (!last) {
      const expectedCursor = after ?? null;
      if (
        page.hasMore ||
        page.nextCursor !== expectedCursor ||
        page.headSequence !== expectedCursor
      ) {
        throw new DurableSessionJournalError(
          'DURABLE_JOURNAL_INVALID_PAGE',
          'Durable Event Store returned inconsistent empty-page metadata',
        );
      }
      return;
    }
    if (
      page.nextCursor !== last.sequence ||
      page.headSequence === null ||
      page.headSequence < last.sequence ||
      page.hasMore !== last.sequence < page.headSequence
    ) {
      throw new DurableSessionJournalError(
        'DURABLE_JOURNAL_INVALID_PAGE',
        'Durable Event Store returned inconsistent cursor metadata',
      );
    }
  }

  private indexCommandEvents(events: readonly DurableEventEnvelope[]): void {
    for (const event of events) {
      if (!event.commandId) {
        continue;
      }
      const existing = this.commandEvents.get(event.commandId) ?? [];
      existing.push(event);
      this.commandEvents.set(event.commandId, existing);
    }
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
