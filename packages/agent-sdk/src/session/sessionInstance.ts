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
  delegate?: PackageLocalSessionDelegate;
}

export interface PackageLocalSessionRuntimePort {
  mcpServerStatus?: ISession['mcpServerStatus'];
  mcpConnect?: ISession['mcpConnect'];
  mcpDisconnect?: ISession['mcpDisconnect'];
  mcpReconnect?: ISession['mcpReconnect'];
  mcpListTools?: ISession['mcpListTools'];
  fork?: ISession['fork'];
}

export interface PackageLocalSessionDelegate {
  readonly messages?: SessionMessage[];
  readonly isClosed?: boolean;
  close?: () => Promise<void>;
  abort?: () => void;
  getDefaultContext?: () => RuntimeContext;
  setDefaultContext?: (context: RuntimeContext) => void;
  setPermissionMode?: ISession['setPermissionMode'];
  setModel?: ISession['setModel'];
  setMaxTurns?: ISession['setMaxTurns'];
  supportedModels?: ISession['supportedModels'];
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
  private readonly delegate?: PackageLocalSessionDelegate;
  private readonly pendingTurns = new PendingTurnBuffer();
  private readonly turnAbort = new TurnAbortController();
  private readonly lifecycle = new SessionLifecycleState({
    pendingTurns: this.pendingTurns,
    turnAbort: this.turnAbort,
  });
  private readonly turns: SessionTurnController;
  private readonly initialMessages: SessionMessage[];
  private defaultContext: RuntimeContext;

  constructor(options: PackageLocalSessionOptions) {
    this.sessionId = options.sessionId;
    this.sessionOptions = options.options;
    this.streamTurn = options.streamTurn;
    this.cleanup = options.cleanup;
    this.runtime = options.runtime;
    this.delegate = options.delegate;
    this.initialMessages = options.initialMessages ?? [];
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
    return this.delegate?.messages ?? this.initialMessages;
  }

  get isClosed(): boolean {
    return this.lifecycle.isClosed() || this.delegate?.isClosed === true;
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
    await this.lifecycle.close(async () => {
      await this.cleanup?.();
      await this.delegate?.close?.();
    });
  }

  abort(): void {
    this.lifecycle.abort();
    this.delegate?.abort?.();
  }

  getDefaultContext(): RuntimeContext {
    return this.delegate?.getDefaultContext?.() ?? this.defaultContext;
  }

  setDefaultContext(context: RuntimeContext): void {
    this.lifecycle.assertOpen();
    this.defaultContext = context;
    this.delegate?.setDefaultContext?.(context);
  }

  setPermissionMode(mode: Parameters<ISession['setPermissionMode']>[0]): void {
    this.lifecycle.assertOpen();
    this.sessionOptions = {
      ...this.sessionOptions,
      permissionMode: mode,
    };
    if (this.delegate?.setPermissionMode) {
      this.delegate.setPermissionMode(mode);
    }
  }

  async setModel(model: Parameters<ISession['setModel']>[0]): Promise<void> {
    this.lifecycle.assertOpen();
    this.sessionOptions = {
      ...this.sessionOptions,
      model,
    };
    if (this.delegate?.setModel) {
      await this.delegate.setModel(model);
    }
  }

  setMaxTurns(maxTurns: Parameters<ISession['setMaxTurns']>[0]): void {
    this.lifecycle.assertOpen();
    this.sessionOptions = {
      ...this.sessionOptions,
      maxTurns,
    };
    if (this.delegate?.setMaxTurns) {
      this.delegate.setMaxTurns(maxTurns);
    }
  }

  async supportedModels(): Promise<ModelInfo[]> {
    if (this.delegate?.supportedModels) {
      return this.delegate.supportedModels();
    }
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
    if (this.delegate?.mcpServerStatus) {
      return this.delegate.mcpServerStatus();
    }
    return [];
  }

  async mcpConnect(serverName: Parameters<ISession['mcpConnect']>[0]): Promise<void> {
    this.lifecycle.assertOpen();
    if (this.runtime?.mcpConnect) {
      await this.runtime.mcpConnect(serverName);
      return;
    }
    if (this.delegate?.mcpConnect) {
      await this.delegate.mcpConnect(serverName);
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
    if (this.delegate?.mcpDisconnect) {
      await this.delegate.mcpDisconnect(serverName);
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
    if (this.delegate?.mcpReconnect) {
      await this.delegate.mcpReconnect(serverName);
      return;
    }
    throw new Error('MCP runtime is not configured for this session.');
  }

  async mcpListTools(): Promise<McpToolInfo[]> {
    if (this.runtime?.mcpListTools) {
      return this.runtime.mcpListTools();
    }
    if (this.delegate?.mcpListTools) {
      return this.delegate.mcpListTools();
    }
    return [];
  }

  async fork(options?: ForkSessionOptions): Promise<ISession> {
    this.lifecycle.assertOpen();
    if (this.runtime?.fork) {
      return this.runtime.fork(options);
    }
    if (this.delegate?.fork) {
      return this.delegate.fork(options);
    }
    throw new Error('Fork runtime is not configured for this session.');
  }

  getLastTrace(): AgentTrace | undefined {
    return this.delegate?.getLastTrace?.();
  }

  getTraces(): AgentTrace[] {
    return this.delegate?.getTraces?.() ?? [];
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
