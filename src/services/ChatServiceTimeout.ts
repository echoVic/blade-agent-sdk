import type { JSONSchema7 } from 'json-schema';
import { ConfigError } from '../errors/ConfigError.js';
import {
  ModelTimeoutError,
  type ModelTimeoutErrorCode,
} from '../errors/ModelTimeoutError.js';
import type {
  ChatConfig,
  ChatResponse,
  IChatService,
  Message,
  StreamChunk,
} from './ChatServiceInterface.js';
import type { RetryEvent } from './RetryPolicy.js';

export const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 600_000;
export const DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS = 300_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface ResolvedModelTimeouts {
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
}

function resolveTimeout(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved)
    || resolved <= 0
    || resolved > MAX_TIMER_DELAY_MS
  ) {
    throw new ConfigError(
      `${name} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`,
    );
  }
  return resolved;
}

function resolveModelTimeouts(config: ChatConfig): ResolvedModelTimeouts {
  return {
    requestTimeoutMs: resolveTimeout(
      config.requestTimeoutMs ?? config.timeout,
      DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
      'requestTimeoutMs',
    ),
    streamIdleTimeoutMs: resolveTimeout(
      config.streamIdleTimeoutMs,
      DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS,
      'streamIdleTimeoutMs',
    ),
  };
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) {
    return signal.reason;
  }
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function awaitWithTimeout<T>(
  operation: () => PromiseLike<T>,
  timeoutMs: number,
  code: ModelTimeoutErrorCode,
  timeoutController: AbortController,
  externalSignal?: AbortSignal,
): Promise<T> {
  if (externalSignal?.aborted) {
    return Promise.reject(abortReason(externalSignal));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    };
    const resolveOnce = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      rejectOnce(externalSignal ? abortReason(externalSignal) : undefined);
    };
    const timer = setTimeout(() => {
      const error = new ModelTimeoutError(code, timeoutMs);
      timeoutController.abort(error);
      rejectOnce(error);
    }, timeoutMs);

    externalSignal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(resolveOnce, rejectOnce);
  });
}

function executionSignal(
  timeoutController: AbortController,
  externalSignal?: AbortSignal,
): AbortSignal {
  return externalSignal
    ? AbortSignal.any([externalSignal, timeoutController.signal])
    : timeoutController.signal;
}

async function runWithRequestTimeout<T>(
  operation: (signal: AbortSignal) => PromiseLike<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  const timeoutController = new AbortController();
  return await awaitWithTimeout(
    () => operation(executionSignal(timeoutController, externalSignal)),
    timeoutMs,
    'MODEL_REQUEST_TIMEOUT',
    timeoutController,
    externalSignal,
  );
}

async function* runGeneratorWithTimeout<TYield, TReturn>(
  createSource: (signal: AbortSignal) => AsyncGenerator<TYield, TReturn, unknown>,
  timeoutMs: number,
  mode: 'request' | 'idle',
  externalSignal?: AbortSignal,
): AsyncGenerator<TYield, TReturn, unknown> {
  externalSignal?.throwIfAborted();
  const timeoutController = new AbortController();
  const signal = executionSignal(timeoutController, externalSignal);
  const source = createSource(signal);
  const startedAt = performance.now();
  let completed = false;
  let timedOut = false;

  try {
    while (true) {
      const remainingMs =
        mode === 'request'
          ? timeoutMs - (performance.now() - startedAt)
          : timeoutMs;
      if (remainingMs <= 0) {
        const code =
          mode === 'request'
            ? 'MODEL_REQUEST_TIMEOUT'
            : 'MODEL_STREAM_IDLE_TIMEOUT';
        const error = new ModelTimeoutError(code, timeoutMs);
        timedOut = true;
        timeoutController.abort(error);
        throw error;
      }

      let step: IteratorResult<TYield, TReturn>;
      try {
        step = await awaitWithTimeout(
          () => source.next(),
          Math.max(1, Math.ceil(remainingMs)),
          mode === 'request'
            ? 'MODEL_REQUEST_TIMEOUT'
            : 'MODEL_STREAM_IDLE_TIMEOUT',
          timeoutController,
          externalSignal,
        );
      } catch (error) {
        timedOut = error instanceof ModelTimeoutError;
        throw error;
      }

      if (step.done) {
        completed = true;
        return step.value;
      }
      yield step.value;
    }
  } finally {
    if (!completed) {
      if (!timeoutController.signal.aborted) {
        timeoutController.abort(new Error('Model stream closed before completion'));
      }
      const closing = source.return(undefined as never);
      if (timedOut || externalSignal?.aborted) {
        void closing.catch(() => {});
      } else {
        await closing;
      }
    }
  }
}

/**
 * Adds bounded request and stream-idle waits around any chat service.
 *
 * This wrapper remains outside model middleware so a middleware that stalls
 * before or after delegating is subject to the same timeout as the provider.
 */
export function wrapChatServiceWithTimeouts(service: IChatService): IChatService {
  resolveModelTimeouts(service.getConfig());

  const wrapped: IChatService = {
    async chat(messages, tools, signal) {
      const { requestTimeoutMs } = resolveModelTimeouts(service.getConfig());
      return await runWithRequestTimeout(
        (operationSignal) => service.chat(
          messages,
          tools,
          operationSignal,
        ),
        requestTimeoutMs,
        signal,
      );
    },
    async sideQuery(messages, signal, options) {
      const { requestTimeoutMs } = resolveModelTimeouts(service.getConfig());
      return await runWithRequestTimeout(
        (operationSignal) => service.sideQuery(
          messages,
          operationSignal,
          options,
        ),
        requestTimeoutMs,
        signal,
      );
    },
    async *streamChat(
      messages: readonly Message[],
      tools?: Array<{
        name: string;
        description: string;
        parameters: JSONSchema7;
      }>,
      signal?: AbortSignal,
    ): AsyncGenerator<StreamChunk, void, unknown> {
      const { streamIdleTimeoutMs } = resolveModelTimeouts(service.getConfig());
      yield* runGeneratorWithTimeout(
        (operationSignal) => service.streamChat(
          messages,
          tools,
          operationSignal,
        ),
        streamIdleTimeoutMs,
        'idle',
        signal,
      );
    },
    getConfig() {
      return service.getConfig();
    },
    updateConfig(newConfig) {
      resolveModelTimeouts({
        ...service.getConfig(),
        ...newConfig,
      });
      service.updateConfig(newConfig);
    },
  };

  if (service.chatWithRetryEvents) {
    const chatWithRetryEvents = service.chatWithRetryEvents.bind(service);
    wrapped.chatWithRetryEvents = async function* (
      messages,
      tools,
      signal,
    ): AsyncGenerator<RetryEvent, ChatResponse> {
      const { requestTimeoutMs } = resolveModelTimeouts(service.getConfig());
      return yield* runGeneratorWithTimeout(
        (operationSignal) => chatWithRetryEvents(
          messages,
          tools,
          operationSignal,
        ),
        requestTimeoutMs,
        'request',
        signal,
      );
    };
  }

  return wrapped;
}
