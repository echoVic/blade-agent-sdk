export interface AgentLoopTurnStart {
  started: boolean;
  turn: number;
}

export interface AgentLoopTurnCounter {
  readonly turnsCount: number;
  readonly previousCompletedTurnCount: number;
  shouldRunBeforeTurn(): boolean;
  beginTurn(): AgentLoopTurnStart;
  requestRetry(): void;
  reset(): void;
}

export interface AgentLoopBeforeTurnHookPayload<TMessage> {
  turn: number;
  messages: readonly TMessage[];
  lastPromptTokens?: number;
}

export interface AgentLoopBeforeTurnConversationLike<TMessage> {
  toArray(): readonly TMessage[];
}

export interface AgentLoopBeforeTurnHookPayloadConversationInput<TMessage> {
  counter: Pick<AgentLoopTurnCounter, 'turnsCount'>;
  conversation: AgentLoopBeforeTurnConversationLike<TMessage>;
  lastPromptTokens?: number;
}

export interface AgentLoopBeforeTurnTokenUsageTrackerLike {
  readonly lastPromptTokens: number | undefined;
}

export interface AgentLoopBeforeTurnHookPayloadLoopStateInput<TMessage> {
  counter: Pick<AgentLoopTurnCounter, 'turnsCount'>;
  conversation: AgentLoopBeforeTurnConversationLike<TMessage>;
  tokenUsageTracker: AgentLoopBeforeTurnTokenUsageTrackerLike;
}

export type AgentLoopBeforeTurnHook<TMessage, TEvent, TReturn> = (
  payload: AgentLoopBeforeTurnHookPayload<TMessage>,
) => AsyncGenerator<TEvent, TReturn>;

export interface AgentLoopBeforeTurnHookContainer<TMessage, TEvent, TReturn> {
  turn?: {
    beforeTurn?: AgentLoopBeforeTurnHook<TMessage, TEvent, TReturn>;
  } | null;
}

export interface RunAgentLoopBeforeTurnHookInput<TMessage, TEvent, TReturn>
  extends AgentLoopBeforeTurnHookPayloadLoopStateInput<TMessage> {
  counter: Pick<AgentLoopTurnCounter, 'turnsCount' | 'shouldRunBeforeTurn'>;
  hooks?: AgentLoopBeforeTurnHookContainer<TMessage, TEvent, TReturn> | null;
}

export interface BeginAgentLoopTurnInput {
  counter: Pick<AgentLoopTurnCounter, 'beginTurn'>;
}

export interface RequestAgentLoopTurnRetryInput {
  counter: Pick<AgentLoopTurnCounter, 'requestRetry'>;
}

export interface ResetAgentLoopTurnCounterInput {
  counter: Pick<AgentLoopTurnCounter, 'reset'>;
}

export function shouldEmitAgentLoopTurnStart(turnStart: AgentLoopTurnStart): boolean {
  return turnStart.started;
}

export function beginAgentLoopTurn(input: BeginAgentLoopTurnInput): AgentLoopTurnStart {
  return input.counter.beginTurn();
}

export function requestAgentLoopTurnRetry(input: RequestAgentLoopTurnRetryInput): void {
  input.counter.requestRetry();
}

export function resetAgentLoopTurnCounter(input: ResetAgentLoopTurnCounterInput): void {
  input.counter.reset();
}

export function buildAgentLoopBeforeTurnHookPayload<TMessage>(
  input: AgentLoopBeforeTurnHookPayload<TMessage>,
): AgentLoopBeforeTurnHookPayload<TMessage> {
  return {
    turn: input.turn,
    messages: input.messages,
    lastPromptTokens: input.lastPromptTokens,
  };
}

export function buildAgentLoopBeforeTurnHookPayloadFromConversation<TMessage>(
  input: AgentLoopBeforeTurnHookPayloadConversationInput<TMessage>,
): AgentLoopBeforeTurnHookPayload<TMessage> {
  return buildAgentLoopBeforeTurnHookPayload({
    turn: input.counter.turnsCount,
    messages: input.conversation.toArray(),
    lastPromptTokens: input.lastPromptTokens,
  });
}

export function buildAgentLoopBeforeTurnHookPayloadFromLoopState<TMessage>(
  input: AgentLoopBeforeTurnHookPayloadLoopStateInput<TMessage>,
): AgentLoopBeforeTurnHookPayload<TMessage> {
  return buildAgentLoopBeforeTurnHookPayloadFromConversation({
    counter: input.counter,
    conversation: input.conversation,
    lastPromptTokens: input.tokenUsageTracker.lastPromptTokens,
  });
}

export function shouldRunAgentLoopBeforeTurnHook<BeforeTurnHook>(
  counter: Pick<AgentLoopTurnCounter, 'shouldRunBeforeTurn'>,
  beforeTurnHook: BeforeTurnHook | null | undefined,
): beforeTurnHook is NonNullable<BeforeTurnHook> {
  return beforeTurnHook !== undefined && beforeTurnHook !== null && counter.shouldRunBeforeTurn();
}

export async function* consumeAgentLoopBeforeTurnStream<Event, ReturnValue>(
  stream: AsyncGenerator<Event, ReturnValue>,
): AsyncGenerator<Event, ReturnValue> {
  while (true) {
    const { value, done } = await stream.next();
    if (done) {
      return value;
    }
    yield value;
  }
}

export async function* runAgentLoopBeforeTurnHook<TMessage, TEvent, TReturn>(
  input: RunAgentLoopBeforeTurnHookInput<TMessage, TEvent, TReturn>,
): AsyncGenerator<TEvent, TReturn | undefined> {
  const beforeTurnHook = input.hooks?.turn?.beforeTurn;
  if (!shouldRunAgentLoopBeforeTurnHook(input.counter, beforeTurnHook)) {
    return undefined;
  }

  return yield* consumeAgentLoopBeforeTurnStream(
    beforeTurnHook(buildAgentLoopBeforeTurnHookPayloadFromLoopState(input)),
  );
}

export function createAgentLoopTurnCounter(): AgentLoopTurnCounter {
  let turnsCount = 0;
  let retryCurrentTurn = false;

  return {
    get turnsCount() {
      return turnsCount;
    },
    get previousCompletedTurnCount() {
      return Math.max(0, turnsCount - 1);
    },
    shouldRunBeforeTurn(): boolean {
      return !retryCurrentTurn;
    },
    beginTurn(): AgentLoopTurnStart {
      if (retryCurrentTurn) {
        retryCurrentTurn = false;
        return { started: false, turn: turnsCount };
      }

      turnsCount += 1;
      return { started: true, turn: turnsCount };
    },
    requestRetry(): void {
      retryCurrentTurn = true;
    },
    reset(): void {
      turnsCount = 0;
      retryCurrentTurn = false;
    },
  };
}
