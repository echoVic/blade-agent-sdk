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

/**
 * Wrap an IChatService without changing its provider-facing contract.
 * Middleware order is stable: the first registered middleware is outermost.
 */
export function wrapChatService(
  service: IChatService,
  middleware: readonly ModelMiddleware[],
): IChatService {
  if (middleware.length === 0) {
    return service;
  }

  const wrapChat = composeMiddleware(
    select(middleware, (entry) => entry.wrapChat),
    (request: ModelChatRequest) =>
      service.chat(
        request.messages,
        request.tools ? [...request.tools] : undefined,
        request.signal,
      ),
  );
  const wrapSideQuery = composeMiddleware(
    select(middleware, (entry) => entry.wrapSideQuery),
    (request: ModelSideQueryRequest) =>
      service.sideQuery(request.messages, request.signal, request.options),
  );
  const wrapStream = composeMiddleware(
    select(middleware, (entry) => entry.wrapStream),
    (request: ModelStreamRequest) =>
      service.streamChat(
        request.messages,
        request.tools ? [...request.tools] : undefined,
        request.signal,
      ),
  );

  const wrapped: IChatService = {
    chat(messages, tools, signal) {
      return wrapChat({
        operation: 'chat',
        model: service.getConfig().model,
        messages,
        tools,
        signal,
      });
    },
    sideQuery(messages, signal, options) {
      return wrapSideQuery({
        operation: 'sideQuery',
        model: service.getConfig().model,
        messages,
        signal,
        options,
      });
    },
    streamChat(messages, tools, signal) {
      return wrapStream({
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
    const wrapRetry = composeMiddleware(
      select(middleware, (entry) => entry.wrapChatWithRetryEvents),
      (request: ModelRetryRequest) =>
        service.chatWithRetryEvents?.(
          request.messages,
          request.tools ? [...request.tools] : undefined,
          request.signal,
        ) as AsyncGenerator<RetryEvent, ChatResponse>,
    );
    wrapped.chatWithRetryEvents = (messages, tools, signal) =>
      wrapRetry({
        operation: 'chatWithRetryEvents',
        model: service.getConfig().model,
        messages,
        tools,
        signal,
      });
  }

  return wrapped;
}
