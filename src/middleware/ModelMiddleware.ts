import type { JSONSchema7 } from 'json-schema';
import type {
  ChatResponse,
  IChatService,
  Message,
  SideQueryOptions,
  StreamChunk,
} from '../services/ChatServiceInterface.js';
import type { RetryEvent } from '../services/RetryPolicy.js';
import { composeMiddleware, type Middleware } from './composeMiddleware.js';

export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema7;
}

interface ModelRequestBase {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly signal?: AbortSignal;
}

export interface ModelChatRequest extends ModelRequestBase {
  readonly operation: 'chat';
  readonly tools?: readonly ModelToolDefinition[];
}

export interface ModelSideQueryRequest extends ModelRequestBase {
  readonly operation: 'sideQuery';
  readonly options?: SideQueryOptions;
}

export interface ModelStreamRequest extends ModelRequestBase {
  readonly operation: 'streamChat';
  readonly tools?: readonly ModelToolDefinition[];
}

export interface ModelRetryRequest extends ModelRequestBase {
  readonly operation: 'chatWithRetryEvents';
  readonly tools?: readonly ModelToolDefinition[];
}

export type ModelChatMiddleware = Middleware<
  ModelChatRequest,
  Promise<ChatResponse>
>;

export type ModelSideQueryMiddleware = Middleware<
  ModelSideQueryRequest,
  Promise<ChatResponse>
>;

export type ModelStreamMiddleware = Middleware<
  ModelStreamRequest,
  AsyncGenerator<StreamChunk, void, unknown>
>;

export type ModelRetryMiddleware = Middleware<
  ModelRetryRequest,
  AsyncGenerator<RetryEvent, ChatResponse>
>;

export interface ModelMiddleware {
  wrapChat?: ModelChatMiddleware;
  wrapSideQuery?: ModelSideQueryMiddleware;
  wrapStream?: ModelStreamMiddleware;
  wrapChatWithRetryEvents?: ModelRetryMiddleware;
}

function select<T>(
  middleware: readonly ModelMiddleware[],
  selector: (entry: ModelMiddleware) => T | undefined,
): T[] {
  return middleware
    .map(selector)
    .filter((entry): entry is T => entry !== undefined);
}

type ModelOperationRequest = ModelRequestBase & {
  readonly operation: string;
};

function composeModelMiddleware<
  TRequest extends ModelOperationRequest,
  TResult,
>(
  middleware: readonly Middleware<TRequest, TResult>[],
  terminal: (request: TRequest) => TResult,
): (request: TRequest) => TResult {
  const stack = [...middleware];

  return (initialRequest: TRequest): TResult => {
    const operation = initialRequest.operation;
    const model = initialRequest.model;
    const signal = initialRequest.signal;
    const guardRequest = (request: TRequest): TRequest => {
      if (request.operation !== operation) {
        throw new Error('Model middleware cannot change the model operation');
      }
      if (request.model !== model) {
        throw new Error('Model middleware cannot change the active model');
      }
      if (request.signal !== signal) {
        throw new Error('Model middleware cannot replace the AbortSignal');
      }
      return Object.freeze({ ...request });
    };
    const guardedStack = stack.map<Middleware<TRequest, TResult>>(
      (entry) => (request, next) => {
        const guardedRequest = guardRequest(request);
        return entry(
          guardedRequest,
          (nextRequest = guardedRequest) => next(nextRequest),
        );
      },
    );

    return composeMiddleware(
      guardedStack,
      (request) => terminal(guardRequest(request)),
    )(guardRequest(initialRequest));
  };
}

/**
 * Wrap an IChatService without changing its provider-facing contract.
 * Middleware order is stable: the first registered middleware is outermost.
 * Request transforms should be deterministic and must preserve cancellation.
 */
export function wrapChatService(
  service: IChatService,
  middleware: readonly ModelMiddleware[],
): IChatService {
  if (middleware.length === 0) {
    return service;
  }

  const wrapChat = composeModelMiddleware(
    select(middleware, (entry) => entry.wrapChat),
    (request: ModelChatRequest) =>
      service.chat(
        request.messages,
        request.tools ? [...request.tools] : undefined,
        request.signal,
      ),
  );
  const wrapSideQuery = composeModelMiddleware(
    select(middleware, (entry) => entry.wrapSideQuery),
    (request: ModelSideQueryRequest) =>
      service.sideQuery(request.messages, request.signal, request.options),
  );
  const wrapStream = composeModelMiddleware(
    select(middleware, (entry) => entry.wrapStream),
    (request: ModelStreamRequest) =>
      service.streamChat(
        request.messages,
        request.tools ? [...request.tools] : undefined,
        request.signal,
      ),
  );

  const wrapped: IChatService = {
    async chat(messages, tools, signal) {
      return await wrapChat({
        operation: 'chat',
        model: service.getConfig().model,
        messages,
        tools,
        signal,
      });
    },
    async sideQuery(messages, signal, options) {
      return await wrapSideQuery({
        operation: 'sideQuery',
        model: service.getConfig().model,
        messages,
        signal,
        options,
      });
    },
    async *streamChat(messages, tools, signal) {
      yield* wrapStream({
        operation: 'streamChat',
        model: service.getConfig().model,
        messages,
        tools,
        signal,
      });
    },
    getConfig() {
      return service.getConfig();
    },
    updateConfig(newConfig) {
      service.updateConfig(newConfig);
    },
  };

  if (service.chatWithRetryEvents) {
    const wrapRetry = composeModelMiddleware(
      select(middleware, (entry) => entry.wrapChatWithRetryEvents),
      (request: ModelRetryRequest) =>
        service.chatWithRetryEvents?.(
          request.messages,
          request.tools ? [...request.tools] : undefined,
          request.signal,
        ) as AsyncGenerator<RetryEvent, ChatResponse>,
    );
    wrapped.chatWithRetryEvents = async function* (messages, tools, signal) {
      return yield* wrapRetry({
        operation: 'chatWithRetryEvents',
        model: service.getConfig().model,
        messages,
        tools,
        signal,
      });
    };
  }

  return wrapped;
}
