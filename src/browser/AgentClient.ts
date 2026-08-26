import { nanoid } from 'nanoid';
import type { UserMessageContent } from '../agent/types.js';
import {
  AGENT_PROTOCOL_VERSION,
  type AgentClientCapabilities,
  type AgentClientInfo,
  type AgentCommand,
  type AgentCommandResult,
  AgentCommandType,
  type AgentEventCursor,
  type AgentInitializationData,
  type AgentInputSubmissionData,
  AgentProtocolError,
  type AgentServerEvent,
  type AgentSessionDescriptor,
  agentInitializationDataSchema,
  agentInputSubmissionDataSchema,
  agentSessionListDataSchema,
  agentSessionResultSchema,
  parseAgentCommandResult,
  parseAgentEventCursor,
  parseAgentServerEvent,
} from '../protocol/index.js';
import {
  CommandId,
  MessageId,
  PermissionRequestId,
  type RequestId,
  SessionId,
} from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';

export interface AgentClientOptions {
  readonly baseUrl: string;
  readonly client: AgentClientInfo;
  readonly capabilities?: AgentClientCapabilities;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>);
  readonly maxCommandAttempts?: number;
  readonly maxEventReconnectAttempts?: number;
  readonly retryBaseDelayMs?: number;
}

export interface AgentClientCommandOptions {
  readonly commandId?: string;
  readonly signal?: AbortSignal;
}

export interface AgentClientEventOptions {
  readonly after?: AgentEventCursor | null;
  readonly signal?: AbortSignal;
}

export class RemoteAgentSession {
  constructor(
    private readonly client: AgentClient,
    readonly sessionId: SessionId,
  ) {}

  send(
    input: UserMessageContent,
    options: AgentClientCommandOptions & {
      readonly priority?: 'now' | 'next' | 'later';
      readonly expectedRequestId?: RequestId;
      readonly maxTurns?: number;
    } = {},
  ): Promise<AgentInputSubmissionData> {
    return this.client.submitInput(this.sessionId, input, options);
  }

  events(options: AgentClientEventOptions = {}): AsyncGenerator<AgentServerEvent> {
    return this.client.events(this.sessionId, options);
  }

  abort(options: AgentClientCommandOptions = {}): Promise<void> {
    return this.client.abortRequest(this.sessionId, options);
  }

  close(options: AgentClientCommandOptions = {}): Promise<void> {
    return this.client.closeSession(this.sessionId, options);
  }

  async fork(
    options: AgentClientCommandOptions & {
      readonly messageId?: string;
      readonly metadata?: JsonObject;
    } = {},
  ): Promise<RemoteAgentSession> {
    return this.client.forkSession(this.sessionId, options);
  }

  read(options: AgentClientCommandOptions = {}) {
    return this.client.readSession(this.sessionId, options);
  }
}

export class AgentClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly maxCommandAttempts: number;
  private readonly maxEventReconnectAttempts: number;
  private readonly retryBaseDelayMs: number;
  private initialization?: Promise<AgentInitializationData>;

  constructor(private readonly options: AgentClientOptions) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error('AgentClient requires a fetch implementation');
    }
    this.fetchImpl = (input, init) => fetchImpl(input, init);
    this.baseUrl = options.baseUrl.replace(/\/+$/g, '');
    this.maxCommandAttempts = options.maxCommandAttempts ?? 3;
    this.maxEventReconnectAttempts = options.maxEventReconnectAttempts ?? 5;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 250;
    if (!Number.isSafeInteger(this.maxCommandAttempts) || this.maxCommandAttempts < 1) {
      throw new RangeError('maxCommandAttempts must be a positive safe integer');
    }
    for (const [name, value] of [
      ['maxEventReconnectAttempts', this.maxEventReconnectAttempts],
      ['retryBaseDelayMs', this.retryBaseDelayMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer`);
      }
    }
  }

  initialize(options: AgentClientCommandOptions = {}): Promise<AgentInitializationData> {
    if (!this.initialization) {
      const initializing = this.sendCommand(
        {
          protocolVersion: AGENT_PROTOCOL_VERSION,
          commandId: CommandId(options.commandId ?? nanoid()),
          type: AgentCommandType.INITIALIZE,
          data: {
            client: this.options.client,
            capabilities: this.options.capabilities,
          },
        },
        options.signal,
      ).then((result) => agentInitializationDataSchema.parse(result.data));
      this.initialization = initializing;
      void initializing.catch(() => {
        if (this.initialization === initializing) {
          this.initialization = undefined;
        }
      });
    }
    return this.initialization;
  }

  async createSession(
    metadata?: JsonObject,
    options: AgentClientCommandOptions = {},
  ): Promise<RemoteAgentSession> {
    await this.initialize({ signal: options.signal });
    const result = await this.sendCommand(
      {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        commandId: CommandId(options.commandId ?? nanoid()),
        type: AgentCommandType.SESSION_CREATE,
        data: { metadata },
      },
      options.signal,
    );
    const descriptor = agentSessionResultSchema.parse(result.data).session;
    return new RemoteAgentSession(this, descriptor.sessionId);
  }

  async resumeSession(
    sessionId: SessionId | string,
    options: AgentClientCommandOptions = {},
  ): Promise<RemoteAgentSession> {
    await this.initialize({ signal: options.signal });
    const id = SessionId(sessionId);
    await this.sendCommand(
      {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        commandId: CommandId(options.commandId ?? nanoid()),
        type: AgentCommandType.SESSION_RESUME,
        data: { sessionId: id },
      },
      options.signal,
    );
    return new RemoteAgentSession(this, id);
  }

  async forkSession(
    sessionId: SessionId | string,
    options: AgentClientCommandOptions & {
      readonly messageId?: string;
      readonly metadata?: JsonObject;
    } = {},
  ): Promise<RemoteAgentSession> {
    await this.initialize({ signal: options.signal });
    const result = await this.sendCommand(
      {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        commandId: CommandId(options.commandId ?? nanoid()),
        type: AgentCommandType.SESSION_FORK,
        data: {
          sessionId: SessionId(sessionId),
          messageId: options.messageId ? MessageId(options.messageId) : undefined,
          metadata: options.metadata,
        },
      },
      options.signal,
    );
    const descriptor = agentSessionResultSchema.parse(result.data).session;
    return new RemoteAgentSession(this, descriptor.sessionId);
  }

  async readSession(
    sessionId: SessionId | string,
    options: AgentClientCommandOptions = {},
  ): Promise<JsonObject> {
    await this.initialize({ signal: options.signal });
    const result = await this.sendCommand(
      {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        commandId: CommandId(options.commandId ?? nanoid()),
        type: AgentCommandType.SESSION_READ,
        data: { sessionId: SessionId(sessionId) },
      },
      options.signal,
    );
    return result.data;
  }

  async listSessions(
    options: AgentClientCommandOptions & {
      readonly cursor?: string;
      readonly limit?: number;
    } = {},
  ): Promise<{
    readonly sessions: readonly AgentSessionDescriptor[];
    readonly nextCursor?: string;
  }> {
    await this.initialize({ signal: options.signal });
    const result = await this.sendCommand(
      {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        commandId: CommandId(options.commandId ?? nanoid()),
        type: AgentCommandType.SESSION_LIST,
        data: {
          cursor: options.cursor,
          limit: options.limit,
        },
      },
      options.signal,
    );
    return agentSessionListDataSchema.parse(result.data);
  }

  async submitInput(
    sessionId: SessionId | string,
    input: UserMessageContent,
    options: AgentClientCommandOptions & {
      readonly priority?: 'now' | 'next' | 'later';
      readonly expectedRequestId?: RequestId;
      readonly maxTurns?: number;
    } = {},
  ): Promise<AgentInputSubmissionData> {
    await this.initialize({ signal: options.signal });
    const result = await this.sendCommand(
      {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        commandId: CommandId(options.commandId ?? nanoid()),
        type: AgentCommandType.INPUT_SUBMIT,
        data: {
          sessionId: SessionId(sessionId),
          input,
          priority: options.priority,
          expectedRequestId: options.expectedRequestId,
          maxTurns: options.maxTurns,
        },
      },
      options.signal,
    );
    return agentInputSubmissionDataSchema.parse(result.data);
  }

  async abortRequest(
    sessionId: SessionId | string,
    options: AgentClientCommandOptions = {},
  ): Promise<void> {
    await this.initialize({ signal: options.signal });
    await this.sendCommand(
      {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        commandId: CommandId(options.commandId ?? nanoid()),
        type: AgentCommandType.REQUEST_ABORT,
        data: { sessionId: SessionId(sessionId) },
      },
      options.signal,
    );
  }

  async closeSession(
    sessionId: SessionId | string,
    options: AgentClientCommandOptions = {},
  ): Promise<void> {
    await this.initialize({ signal: options.signal });
    await this.sendCommand(
      {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        commandId: CommandId(options.commandId ?? nanoid()),
        type: AgentCommandType.SESSION_CLOSE,
        data: { sessionId: SessionId(sessionId) },
      },
      options.signal,
    );
  }

  async resolvePermission(
    sessionId: SessionId | string,
    permissionRequestId: PermissionRequestId | string,
    response: {
      readonly approved: boolean;
      readonly reason?: string;
      readonly scope?: 'once' | 'session';
    },
    options: AgentClientCommandOptions = {},
  ): Promise<void> {
    await this.initialize({ signal: options.signal });
    await this.sendCommand(
      {
        protocolVersion: AGENT_PROTOCOL_VERSION,
        commandId: CommandId(options.commandId ?? nanoid()),
        type: AgentCommandType.PERMISSION_RESOLVE,
        data: {
          sessionId: SessionId(sessionId),
          permissionRequestId: PermissionRequestId(permissionRequestId),
          ...response,
        },
      },
      options.signal,
    );
  }

  async *events(
    sessionId: SessionId | string,
    options: AgentClientEventOptions = {},
  ): AsyncGenerator<AgentServerEvent> {
    const id = SessionId(sessionId);
    let cursor: AgentEventCursor | null = null;
    if (options.after) {
      try {
        cursor = parseAgentEventCursor(options.after);
      } catch (error) {
        throw new AgentProtocolError(
          'INVALID_COMMAND',
          'Event cursor is invalid',
          400,
          false,
          undefined,
          undefined,
          { cause: error },
        );
      }
      if (cursor.sessionId !== id) {
        throw new AgentProtocolError(
          'INVALID_COMMAND',
          `Event cursor belongs to Session ${cursor.sessionId}, expected ${id}`,
          400,
        );
      }
    }
    await this.initialize({ signal: options.signal });
    let after = cursor?.sequence ?? 0;
    let attempts = 0;

    while (!options.signal?.aborted) {
      const headers = await this.resolveHeaders();
      if (after > 0) {
        headers['last-event-id'] = String(after);
      }
      let received = false;
      try {
        const response = await this.fetchImpl(
          `${this.baseUrl}/sessions/${encodeURIComponent(id)}/events?after=${after}`,
          {
            method: 'GET',
            headers: {
              accept: 'text/event-stream',
              ...headers,
            },
            signal: options.signal,
          },
        );
        if (!response.ok || !response.body) {
          throw await this.responseError(response);
        }
        for await (const event of parseEventStream(response.body)) {
          if (event.sessionId !== id) {
            throw new AgentProtocolError(
              'INVALID_COMMAND',
              `Received an event for Session ${event.sessionId}, expected ${id}`,
              502,
            );
          }
          if (event.sequence <= after) {
            throw new AgentProtocolError(
              'INVALID_COMMAND',
              `Received non-monotonic event sequence ${event.sequence} after ${after}`,
              502,
            );
          }
          received = true;
          attempts = 0;
          after = event.sequence;
          yield event;
          if (event.type === 'session.closed') {
            return;
          }
        }
      } catch (error) {
        if (options.signal?.aborted) {
          throw options.signal.reason ?? error;
        }
        if (
          error instanceof AgentProtocolError &&
          (!error.retryable || error.protocolCode === 'STALE_CURSOR')
        ) {
          throw error;
        }
        attempts = received ? 1 : attempts + 1;
        if (attempts > this.maxEventReconnectAttempts) {
          throw error;
        }
        await delay(this.retryDelay(attempts), options.signal);
        continue;
      }

      attempts = received ? 1 : attempts + 1;
      if (attempts > this.maxEventReconnectAttempts) {
        throw new AgentProtocolError(
          'INTERNAL_ERROR',
          'Agent event stream ended before Session closure',
          502,
          true,
        );
      }
      await delay(this.retryDelay(attempts), options.signal);
    }
  }

  private async sendCommand(
    command: AgentCommand,
    signal?: AbortSignal,
  ): Promise<Extract<AgentCommandResult<JsonObject>, { ok: true }>> {
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/commands`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(await this.resolveHeaders()),
          },
          body: JSON.stringify(command),
          signal,
        });
        let result: AgentCommandResult<JsonObject>;
        try {
          result = parseAgentCommandResult(await response.json());
        } catch (error) {
          throw new AgentProtocolError(
            'INTERNAL_ERROR',
            'Agent server returned an invalid command response',
            response.status,
            this.isRetryableStatus(response.status),
            this.retryAfterMs(response),
            undefined,
            { cause: error },
          );
        }
        if (result.ok) {
          if (!response.ok) {
            throw new AgentProtocolError(
              'INTERNAL_ERROR',
              `Agent server returned success with HTTP ${response.status}`,
              response.status,
              this.isRetryableStatus(response.status),
              this.retryAfterMs(response),
            );
          }
          return result;
        }
        throw new AgentProtocolError(
          result.error.code,
          result.error.message,
          response.status,
          result.error.retryable,
          result.error.retryAfterMs,
          result.error.details,
        );
      } catch (error) {
        if (signal?.aborted) {
          throw signal.reason ?? error;
        }
        if (error instanceof AgentProtocolError && !error.retryable) {
          throw error;
        }
        if (attempt >= this.maxCommandAttempts) {
          throw error;
        }
        await delay(
          error instanceof AgentProtocolError && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : this.retryDelay(attempt),
          signal,
        );
      }
    }
  }

  private async responseError(response: Response): Promise<AgentProtocolError> {
    try {
      const result = parseAgentCommandResult(await response.json());
      if (!result.ok) {
        return new AgentProtocolError(
          result.error.code,
          result.error.message,
          response.status,
          result.error.retryable,
          result.error.retryAfterMs,
          result.error.details,
        );
      }
    } catch {
      // Fall through to a transport-level error.
    }
    return new AgentProtocolError(
      'INTERNAL_ERROR',
      `Agent server request failed with HTTP ${response.status}`,
      response.status,
      this.isRetryableStatus(response.status),
      this.retryAfterMs(response),
    );
  }

  private async resolveHeaders(): Promise<Record<string, string>> {
    return typeof this.options.headers === 'function'
      ? this.options.headers()
      : { ...(this.options.headers ?? {}) };
  }

  private retryDelay(attempt: number): number {
    const exponential = this.retryBaseDelayMs * 2 ** Math.max(0, attempt - 1);
    return exponential + Math.floor(Math.random() * this.retryBaseDelayMs);
  }

  private isRetryableStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
  }

  private retryAfterMs(response: Response): number | undefined {
    const value = response.headers.get('retry-after');
    if (!value) {
      return undefined;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1000);
    }
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
  }
}

async function* parseEventStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<AgentServerEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) {
          yield parseAgentServerEvent(JSON.parse(data));
        }
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
      if (done) {
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new DOMException('Request aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
