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
  initialMessages?: SessionMessage[];
  cleanup?: SessionCloseCleanup;
  runtime?: PackageLocalSessionRuntimePort;
}

export interface PackageLocalSessionRuntimePort {
  loadMessages?: () => Promise<SessionMessage[]> | SessionMessage[];
  mcpServerStatus?: ISession['mcpServerStatus'];
  mcpConnect?: ISession['mcpConnect'];
  mcpDisconnect?: ISession['mcpDisconnect'];
  mcpReconnect?: ISession['mcpReconnect'];
  mcpListTools?: ISession['mcpListTools'];
  fork?: ISession['fork'];
  getLastTrace?: ISession['getLastTrace'];
  getTraces?: ISession['getTraces'];
}

export class PackageLocalSession implements ISession {
  readonly sessionId: SessionId;
  private sessionOptions: SessionOptions;
  private readonly streamTurn: PackageLocalSessionStreamTurn;
  private readonly cleanup?: SessionCloseCleanup;
  private readonly runtime?: PackageLocalSessionRuntimePort;
  private readonly pendingTurns = new PendingTurnBuffer();
  private readonly turnAbort = new TurnAbortController();
  private readonly lifecycle = new SessionLifecycleState({
    pendingTurns: this.pendingTurns,
    turnAbort: this.turnAbort,
  });
  private readonly turns: SessionTurnController;
  private messagesSnapshot: SessionMessage[];
  private defaultContext: RuntimeContext;

  constructor(options: PackageLocalSessionOptions) {
    this.sessionId = options.sessionId;
    this.sessionOptions = options.options;
    this.streamTurn = options.streamTurn;
    this.cleanup = options.cleanup;
    this.runtime = options.runtime;
    this.messagesSnapshot = options.initialMessages ?? [];
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
    return this.messagesSnapshot;
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
      await this.refreshMessages();
    } finally {
      turn.cleanup();
    }
  }

  private async refreshMessages(): Promise<void> {
    const messages = await this.runtime?.loadMessages?.();
    if (messages) {
      this.messagesSnapshot = messages;
    }
  }

  async close(): Promise<void> {
    await this.lifecycle.close(async () => {
      await this.cleanup?.();
    });
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

  setPermissionMode(mode: Parameters<ISession['setPermissionMode']>[0]): void {
    this.lifecycle.assertOpen();
    this.sessionOptions = {
      ...this.sessionOptions,
      permissionMode: mode,
    };
  }

  async setModel(model: Parameters<ISession['setModel']>[0]): Promise<void> {
    this.lifecycle.assertOpen();
    this.sessionOptions = {
      ...this.sessionOptions,
      model,
    };
  }

  setMaxTurns(maxTurns: Parameters<ISession['setMaxTurns']>[0]): void {
    this.lifecycle.assertOpen();
    this.sessionOptions = {
      ...this.sessionOptions,
      maxTurns,
    };
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
    if (this.runtime?.mcpServerStatus) {
      return this.runtime.mcpServerStatus();
    }
    return [];
  }

  async mcpConnect(serverName: Parameters<ISession['mcpConnect']>[0]): Promise<void> {
    this.lifecycle.assertOpen();
    if (this.runtime?.mcpConnect) {
      await this.runtime.mcpConnect(serverName);
      return;
    }
    throw new Error('MCP runtime is not configured for this session.');
  }

  async mcpDisconnect(serverName: Parameters<ISession['mcpDisconnect']>[0]): Promise<void> {
    this.lifecycle.assertOpen();
    if (this.runtime?.mcpDisconnect) {
      await this.runtime.mcpDisconnect(serverName);
      return;
    }
    throw new Error('MCP runtime is not configured for this session.');
  }

  async mcpReconnect(serverName: Parameters<ISession['mcpReconnect']>[0]): Promise<void> {
    this.lifecycle.assertOpen();
    if (this.runtime?.mcpReconnect) {
      await this.runtime.mcpReconnect(serverName);
      return;
    }
    throw new Error('MCP runtime is not configured for this session.');
  }

  async mcpListTools(): Promise<McpToolInfo[]> {
    if (this.runtime?.mcpListTools) {
      return this.runtime.mcpListTools();
    }
    return [];
  }

  async fork(options?: ForkSessionOptions): Promise<ISession> {
    this.lifecycle.assertOpen();
    if (this.runtime?.fork) {
      return this.runtime.fork(options);
    }
    throw new Error('Fork runtime is not configured for this session.');
  }

  getLastTrace(): AgentTrace | undefined {
    return this.runtime?.getLastTrace?.();
  }

  getTraces(): AgentTrace[] {
    return this.runtime?.getTraces?.() ?? [];
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
