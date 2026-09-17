import type { JSONSchema7 } from 'json-schema';
import type { InternalLogger } from '../../logging/Logger.js';
import { type ModelIdentity, resolveModelIdentity } from '../../model/identity.js';
import type { ModelMessage } from '../../model/message.js';
import type { ModelResponse } from '../../model/service.js';
import { isSteeringInterruptSignal } from '../../types/abort.js';
import type { ModelAttemptId } from '../../types/identifiers.js';
import type { AgentEvent } from '../AgentEvent.js';
import type { ModelExecutionLifecycle, ModelRequestLifecycle } from '../ModelExecutionLifecycle.js';
import type { TurnState } from '../state/TurnState.js';
import { streamChatResponse } from './streamChatResponse.js';

export interface RunTurnInput {
  turnState: TurnState;
  messages: readonly ModelMessage[];
  streaming?: boolean;
  signal?: AbortSignal;
  modelExecutionLifecycle?: ModelExecutionLifecycle;
  logger?: InternalLogger;
}

export interface TurnOutcome {
  chatResponse: ModelResponse;
  modelIdentity: ModelIdentity;
  modelAttemptId?: ModelAttemptId;
}

function abortReason(signal?: AbortSignal): 'steering' | 'request_interrupted' {
  return isSteeringInterruptSignal(signal) ? 'steering' : 'request_interrupted';
}

async function settleFailure(
  lifecycle: ModelRequestLifecycle | undefined,
  signal: AbortSignal | undefined,
  error: unknown,
): Promise<void> {
  if (!lifecycle) return;
  try {
    if (signal?.aborted) {
      await lifecycle.onAborted(abortReason(signal));
    } else {
      await lifecycle.onFailed(error);
    }
  } catch (settlementError) {
    throw new AggregateError(
      [error, settlementError],
      'Model request and durable settlement both failed',
    );
  }
}

async function* requestModel(
  input: RunTurnInput,
  tools: Array<{ name: string; description: string; parameters: JSONSchema7 }>,
): AsyncGenerator<AgentEvent, ModelResponse> {
  const { modelService } = input.turnState;
  if (input.streaming) {
    const stream = streamChatResponse(
      () => modelService,
      input.messages,
      tools,
      input.signal,
      input.logger,
    );
    let completed = false;
    try {
      while (true) {
        const next = await stream.next();
        if (next.done) {
          completed = true;
          return next.value;
        }
        yield next.value;
      }
    } finally {
      if (!completed) await stream.return(undefined as never);
    }
  }

  if (modelService.chatWithRetryEvents) {
    const stream = modelService.chatWithRetryEvents(input.messages, tools, input.signal);
    let completed = false;
    try {
      while (true) {
        const next = await stream.next();
        if (next.done) {
          completed = true;
          return next.value;
        }
        yield {
          type: 'api_retry',
          attempt: next.value.attempt,
          maxRetries: next.value.maxRetries,
          delayMs: next.value.delayMs,
          error: next.value.error,
        };
      }
    } finally {
      if (!completed) await stream.return(undefined as never);
    }
  }

  return await modelService.chat(input.messages, tools, input.signal);
}

export async function* runTurn(input: RunTurnInput): AsyncGenerator<AgentEvent, TurnOutcome> {
  const tools = input.turnState.tools as Array<{
    name: string;
    description: string;
    parameters: JSONSchema7;
  }>;
  const modelIdentity = resolveModelIdentity(input.turnState.modelService.getConfig());
  const lifecycle = await input.modelExecutionLifecycle?.onModelRequestStarting({
    turn: input.turnState.turn,
    model: modelIdentity.model,
    modelIdentity,
    streaming: input.streaming === true,
  });
  await input.turnState.executionContext.assertExecutionLease?.();

  let settled = false;
  try {
    const chatResponse = yield* requestModel(input, tools);
    if (input.signal?.aborted) {
      settled = true;
      await lifecycle?.onAborted(abortReason(input.signal));
    } else {
      settled = true;
      await lifecycle?.onCompleted(chatResponse);
    }
    return {
      chatResponse,
      modelIdentity,
      ...(lifecycle?.modelAttemptId ? { modelAttemptId: lifecycle.modelAttemptId } : {}),
    };
  } catch (error) {
    if (!settled) {
      settled = true;
      await settleFailure(lifecycle, input.signal, error);
    }
    throw error;
  } finally {
    if (!settled) {
      await lifecycle?.onAborted(abortReason(input.signal));
    }
  }
}
