import { PendingTurnBuffer } from './pendingTurn.js';
import { SessionLifecycleState, type SessionCloseCleanup } from './lifecycle.js';
import {
  type ActiveSessionTurn,
  SessionTurnController,
} from './turn.js';
import { TurnAbortController } from './turnAbort.js';
import type { AgentTrace } from '../observability/types.js';
import type {
  ForkSessionOptions,
  ISession,
  McpServerStatus,
  McpToolInfo,
  ModelInfo,
  RuntimeContext,
  SendOptions,
  SessionId,
  SessionMessage,
  SessionOptions,
  StreamMessage,
  StreamOptions,
  UserMessageContent,
} from './types.js';

export type PackageLocalSessionStreamTurn = (
  turn: ActiveSessionTurn,
  options?: StreamOptions,
  context?: PackageLocalSessionStreamContext,
) => AsyncGenerator<StreamMessage>;

export interface PackageLocalSessionStreamContext {
  sessionId: SessionId;
  options: SessionOptions;
}

export interface PackageLocalSessionOptions {
  sessionId: SessionId;
  options: SessionOptions;
  streamTurn: PackageLocalSessionStreamTurn;
  createTurnId: () => string;
  cleanup?: SessionCloseCleanup;
}

export class PackageLocalSession implements ISession {
  readonly sessionId: SessionId;
  private readonly sessionOptions: SessionOptions;
  private readonly streamTurn: PackageLocalSessionStreamTurn;
  private readonly cleanup?: SessionCloseCleanup;
  private readonly pendingTurns = new PendingTurnBuffer();
  private readonly turnAbort = new TurnAbortController();
  private readonly lifecycle = new SessionLifecycleState({
    pendingTurns: this.pendingTurns,
    turnAbort: this.turnAbort,
  });
  private readonly turns: SessionTurnController;
  private defaultContext: RuntimeContext;

  constructor(options: PackageLocalSessionOptions) {
    this.sessionId = options.sessionId;
    this.sessionOptions = options.options;
    this.streamTurn = options.streamTurn;
    this.cleanup = options.cleanup;
    this.defaultContext = options.options.defaultContext ?? {};
    this.turns = new SessionTurnController({
      sessionId: options.sessionId,
      pendingTurns: this.pendingTurns,
      turnAbort: this.turnAbort,
      lifecycle: this.lifecycle,
      getDefaultContext: () => this.defaultContext,
      createTurnId: options.createTurnId,
    });
  }

  get messages(): SessionMessage[] {
    return [];
  }

  get isClosed(): boolean {
    return this.lifecycle.isClosed();
  }

  async send(message: UserMessageContent, options?: SendOptions): Promise<void> {
    this.turns.send(message, options);
  }

  async *stream(options?: StreamOptions): AsyncGenerator<StreamMessage> {
    const turn = this.turns.beginStreamTurn();
    try {
      yield* this.streamTurn(turn, options, {
        sessionId: this.sessionId,
        options: this.sessionOptions,
      });
    } finally {
      turn.cleanup();
    }
  }

  async close(): Promise<void> {
    await this.lifecycle.close(this.cleanup);
  }

  abort(): void {
    this.lifecycle.abort();
  }

  getDefaultContext(): RuntimeContext {
    return this.defaultContext;
  }

  setDefaultContext(context: RuntimeContext): void {
    this.lifecycle.assertOpen();
    this.defaultContext = context;
  }

  setPermissionMode(): void {
    throw new Error('setPermissionMode is not implemented by PackageLocalSession yet.');
  }

  async setModel(): Promise<void> {
    throw new Error('setModel is not implemented by PackageLocalSession yet.');
  }

  setMaxTurns(): void {
    throw new Error('setMaxTurns is not implemented by PackageLocalSession yet.');
  }

  async supportedModels(): Promise<ModelInfo[]> {
    return [
      {
        id: 'default',
        name: this.sessionOptions.model,
        provider: this.sessionOptions.provider.type,
      },
    ];
  }

  async mcpServerStatus(): Promise<McpServerStatus[]> {
    return [];
  }

  async mcpConnect(): Promise<void> {
    throw new Error('mcpConnect is not implemented by PackageLocalSession yet.');
  }

  async mcpDisconnect(): Promise<void> {
    throw new Error('mcpDisconnect is not implemented by PackageLocalSession yet.');
  }

  async mcpReconnect(): Promise<void> {
    throw new Error('mcpReconnect is not implemented by PackageLocalSession yet.');
  }

  async mcpListTools(): Promise<McpToolInfo[]> {
    return [];
  }

  async fork(_options?: ForkSessionOptions): Promise<ISession> {
    throw new Error('fork is not implemented by PackageLocalSession yet.');
  }

  getLastTrace(): AgentTrace | undefined {
    return undefined;
  }

  getTraces(): AgentTrace[] {
    return [];
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
