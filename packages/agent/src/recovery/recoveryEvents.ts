export type AgentRecoveryProjectionKind =
  | 'started'
  | 'compact_failed'
  | 'retrying'
  | 'exhausted'
  | 'reset';

export type AgentRecoveryStatePhase = 'started' | 'retrying' | 'failed' | 'reset';

export type AgentRecoveryStateReason =
  | 'context_overflow'
  | 'reactive_compact_failed'
  | 'reactive_compact_retry'
  | 'recovery_exhausted';

export type AgentRecoveryEventReason =
  | 'context_overflow'
  | 'reactive_compact'
  | 'recovery_exhausted';

export interface AgentRecoveryStateChange {
  turn: number;
  phase: AgentRecoveryStatePhase;
  reason?: AgentRecoveryStateReason;
  attempt: number;
}

export interface AgentRecoveryEvent {
  type: 'recovery';
  phase: 'started' | 'retrying' | 'failed';
  reason: AgentRecoveryEventReason;
}

export interface AgentModelFallbackEvent {
  type: 'model_fallback';
  originalModel: string;
  fallbackModel: string;
}

export interface AgentModelFallbackEventInput {
  originalModel: string;
  fallbackModel: string;
}

export interface AgentRecoveryCompactStreamResult {
  recovered: boolean;
}

export interface AgentReactiveCompactHookPayload<TMessage> {
  messages: readonly TMessage[];
}

export interface AgentReactiveCompactConversationLike<TMessage> {
  toArray(): readonly TMessage[];
}

export interface AgentReactiveCompactHookPayloadConversationInput<TMessage> {
  conversation: AgentReactiveCompactConversationLike<TMessage>;
}

export type AgentReactiveCompactHook<TMessage, Event> = (
  payload: AgentReactiveCompactHookPayload<TMessage>,
) => AsyncGenerator<Event, boolean | undefined>;

export interface AgentReactiveCompactHookContainer<TMessage, Event> {
  recovery?: {
    reactiveCompact?: AgentReactiveCompactHook<TMessage, Event> | null;
  } | null;
}

export interface HasAgentReactiveCompactHookInput<TMessage, Event> {
  hooks?: AgentReactiveCompactHookContainer<TMessage, Event> | null;
}

export interface BuildAgentRecoveryCompactStreamFromHookContainerInput<TMessage, Event>
  extends HasAgentReactiveCompactHookInput<TMessage, Event> {
  conversation: AgentReactiveCompactConversationLike<TMessage>;
}

export type AgentRecoveryProjectionInput =
  | {
      kind: Exclude<AgentRecoveryProjectionKind, 'reset'>;
      turn: number;
      attempt: number;
    }
  | {
      kind: 'reset';
      turn: number;
    };

export function buildAgentRecoveryProjectionInput(
  input: AgentRecoveryProjectionInput,
): AgentRecoveryProjectionInput {
  if (input.kind === 'reset') {
    return {
      kind: input.kind,
      turn: input.turn,
    };
  }

  return {
    kind: input.kind,
    turn: input.turn,
    attempt: input.attempt,
  };
}

export interface AgentRecoveryProjection {
  stateChange: AgentRecoveryStateChange;
  event?: AgentRecoveryEvent;
}

export interface AgentRecoveryEffects {
  stateChanges: [AgentRecoveryStateChange];
  events: AgentRecoveryEvent[];
}

export interface AgentRecoveryAttemptEffectsInput {
  turn: number;
  attempt: number;
}

export interface AgentRecoveryResetEffectsInput {
  turn: number;
}

export interface AgentRecoveryStateChangeHookContainer {
  recovery?: {
    onStateChange?: (stateChange: AgentRecoveryStateChange) => Promise<void> | void;
  } | null;
}

export interface RunAgentRecoveryStateChangeHooksInput {
  effects: AgentRecoveryEffects;
  hooks?: AgentRecoveryStateChangeHookContainer | null;
}

export type AgentRecoveryProjectionWithEvent = AgentRecoveryProjection & {
  event: AgentRecoveryEvent;
};

export function buildAgentRecoveryProjection(
  input: AgentRecoveryProjectionInput,
): AgentRecoveryProjection {
  switch (input.kind) {
    case 'started':
      return {
        stateChange: {
          turn: input.turn,
          phase: 'started',
          reason: 'context_overflow',
          attempt: input.attempt,
        },
        event: {
          type: 'recovery',
          phase: 'started',
          reason: 'context_overflow',
        },
      };
    case 'compact_failed':
      return {
        stateChange: {
          turn: input.turn,
          phase: 'failed',
          reason: 'reactive_compact_failed',
          attempt: input.attempt,
        },
        event: {
          type: 'recovery',
          phase: 'failed',
          reason: 'reactive_compact',
        },
      };
    case 'retrying':
      return {
        stateChange: {
          turn: input.turn,
          phase: 'retrying',
          reason: 'reactive_compact_retry',
          attempt: input.attempt,
        },
        event: {
          type: 'recovery',
          phase: 'retrying',
          reason: 'reactive_compact',
        },
      };
    case 'exhausted':
      return {
        stateChange: {
          turn: input.turn,
          phase: 'failed',
          reason: 'recovery_exhausted',
          attempt: input.attempt,
        },
        event: {
          type: 'recovery',
          phase: 'failed',
          reason: 'recovery_exhausted',
        },
      };
    case 'reset':
      return {
        stateChange: {
          turn: input.turn,
          phase: 'reset',
          attempt: 0,
        },
      };
  }
}

export function shouldEmitAgentRecoveryEvent(
  projection: AgentRecoveryProjection,
): projection is AgentRecoveryProjectionWithEvent {
  return projection.event !== undefined;
}

export function buildAgentRecoveryEffects(
  projection: AgentRecoveryProjection,
): AgentRecoveryEffects {
  return {
    stateChanges: [projection.stateChange],
    events: shouldEmitAgentRecoveryEvent(projection) ? [projection.event] : [],
  };
}

export function buildAgentRecoveryResetEffects(
  input: AgentRecoveryResetEffectsInput,
): AgentRecoveryEffects {
  return buildAgentRecoveryEffects(
    buildAgentRecoveryProjection(
      buildAgentRecoveryProjectionInput({
        kind: 'reset',
        turn: input.turn,
      }),
    ),
  );
}

export function buildAgentRecoveryStartedEffects(
  input: AgentRecoveryAttemptEffectsInput,
): AgentRecoveryEffects {
  return buildAgentRecoveryEffects(
    buildAgentRecoveryProjection(
      buildAgentRecoveryProjectionInput({
        kind: 'started',
        turn: input.turn,
        attempt: input.attempt,
      }),
    ),
  );
}

export async function runAgentRecoveryStateChangeHooks(
  input: RunAgentRecoveryStateChangeHooksInput,
): Promise<AgentRecoveryEffects> {
  for (const stateChange of input.effects.stateChanges) {
    await input.hooks?.recovery?.onStateChange?.(stateChange);
  }

  return input.effects;
}

export function buildAgentReactiveCompactHookPayload<TMessage>(
  input: AgentReactiveCompactHookPayload<TMessage>,
): AgentReactiveCompactHookPayload<TMessage> {
  return {
    messages: input.messages,
  };
}

export function buildAgentReactiveCompactHookPayloadFromConversation<TMessage>(
  input: AgentReactiveCompactHookPayloadConversationInput<TMessage>,
): AgentReactiveCompactHookPayload<TMessage> {
  return buildAgentReactiveCompactHookPayload({
    messages: input.conversation.toArray(),
  });
}

export function hasAgentReactiveCompactHook<TMessage, Event>(
  input: HasAgentReactiveCompactHookInput<TMessage, Event>,
): boolean {
  return typeof input.hooks?.recovery?.reactiveCompact === 'function';
}

export function buildAgentRecoveryCompactStreamFromHookContainer<TMessage, Event>(
  input: BuildAgentRecoveryCompactStreamFromHookContainerInput<TMessage, Event>,
): AsyncGenerator<Event, boolean | undefined> | undefined {
  return input.hooks?.recovery?.reactiveCompact?.(
    buildAgentReactiveCompactHookPayloadFromConversation({
      conversation: input.conversation,
    }),
  );
}

export async function* consumeAgentRecoveryCompactStream<Event>(
  stream: AsyncGenerator<Event, boolean | undefined>,
): AsyncGenerator<Event, AgentRecoveryCompactStreamResult> {
  const recovered = yield* stream;
  return { recovered: recovered === true };
}

export function buildAgentModelFallbackEvent(
  input: AgentModelFallbackEventInput,
): AgentModelFallbackEvent {
  return {
    type: 'model_fallback',
    originalModel: input.originalModel,
    fallbackModel: input.fallbackModel,
  };
}
