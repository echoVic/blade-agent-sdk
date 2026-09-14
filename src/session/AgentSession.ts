import type { UserMessageContent } from '../agent/types.js';
import type { AgentTrace } from '../observability/index.js';
import type { RuntimeContext } from '../runtime/index.js';
import type { PermissionMode } from '../types/constants.js';
import type { InputId, SessionId } from '../types/identifiers.js';
import type {
  DurableEventSubscription,
  DurableEventSubscriptionOptions,
} from './events/DurableEventSubscription.js';
import type { DurableExecutionLease as DurableExecutionLeaseSnapshot } from './events/DurableExecutionLeaseStore.js';
import type {
  DurableSessionProjection,
  DurableSessionRecoveryPlan,
} from './events/DurableSessionProjector.js';
import { SessionDurability } from './SessionDurability.js';
import type { SessionHostProfile } from './SessionHostProfile.js';
import { SessionLifecycle } from './SessionLifecycle.js';
import { SessionRequestCoordinator } from './SessionRequestCoordinator.js';
import { type DurableSessionOrigin, SessionState } from './SessionState.js';
import { SessionStreamRunner } from './SessionStreamRunner.js';
import type {
  ForkSessionOptions,
  InputSubmission,
  ISession,
  McpServerStatus,
  McpToolInfo,
  ModelInfo,
  PendingSessionInput,
  SendOptions,
  SessionHandoffResult,
  SessionOptions,
  SessionStreamEvent,
  StreamOptions,
} from './types.js';

/**
 * Thin public Session facade. Mutable execution state and subsystem ownership
 * live in SessionState and the dedicated coordinators.
 */
export class AgentSession implements ISession {
  private readonly state: SessionState;
  private readonly durability: SessionDurability;
  private readonly requests: SessionRequestCoordinator;
  private readonly lifecycle: SessionLifecycle;
  private readonly streams: SessionStreamRunner;

  constructor(
    options: SessionOptions,
    sessionId?: SessionId,
    isResume = false,
    hostProfile?: SessionHostProfile,
    durableOrigin?: DurableSessionOrigin,
  ) {
    this.state = new SessionState(options, sessionId, isResume, hostProfile, durableOrigin);
    this.durability = new SessionDurability(this.state);
    this.requests = new SessionRequestCoordinator(this.state, this.durability, () =>
      this.ensureInitialized(),
    );
    this.lifecycle = new SessionLifecycle(this.state, this.durability, this.requests);
    this.streams = new SessionStreamRunner(
      this.state,
      this.durability,
      this.requests,
      () => this.ensureInitialized(),
      () => this.lifecycle.abort(),
    );
  }

  get runtime() {
    return this.state.runtime;
  }

  get inputMutex() {
    return this.state.inputMutex;
  }

  get executionLease() {
    return this.state.executionLease;
  }

  get sessionId(): SessionId {
    return this.state.sessionId;
  }

  get messages() {
    return [...this.state.messages];
  }

  get isClosed(): boolean {
    return this.state.isClosed;
  }

  getDefaultContext(): RuntimeContext {
    return this.state.defaultContext;
  }

  setDefaultContext(context: RuntimeContext): void {
    this.state.defaultContext = context;
  }

  getLastTrace(): AgentTrace | undefined {
    return this.state.traces.at(-1);
  }

  getTraces(): AgentTrace[] {
    return [...this.state.traces];
  }

  getDurableProjection(): DurableSessionProjection | null {
    return this.state.durableJournal?.getProjection() ?? null;
  }

  getDurableRecoveryPlan(): DurableSessionRecoveryPlan | null {
    return this.state.durableJournal?.getRecoveryPlan() ?? null;
  }

  getExecutionLease(): DurableExecutionLeaseSnapshot | null {
    return this.state.executionLease?.snapshot ?? null;
  }

  async subscribeDurableEvents(
    options: DurableEventSubscriptionOptions = {},
  ): Promise<DurableEventSubscription> {
    await this.lifecycle.ensureInitialized();
    return this.durability.subscribe(options);
  }

  initialize(): Promise<void> {
    return this.lifecycle.initialize();
  }

  ensureInitialized(): Promise<void> {
    return this.lifecycle.ensureInitialized();
  }

  loadHistory(): Promise<void> {
    return this.requests.loadHistory();
  }

  send(message: UserMessageContent, options?: SendOptions): Promise<InputSubmission> {
    return this.requests.send(message, options);
  }

  getPendingInputs(): readonly PendingSessionInput[] {
    return this.requests.getPendingInputs();
  }

  cancelInput(inputId: InputId): Promise<boolean> {
    return this.requests.cancelInput(inputId);
  }

  stream(options?: StreamOptions): AsyncGenerator<SessionStreamEvent> {
    return this.streams.stream(options);
  }

  close(): Promise<void> {
    return this.lifecycle.close();
  }

  suspendForHandoff(): Promise<SessionHandoffResult> {
    return this.lifecycle.suspendForHandoff();
  }

  disposeAfterFork(): Promise<void> {
    return this.lifecycle.disposeAfterFork();
  }

  abort(): Promise<void> {
    return this.lifecycle.abort();
  }

  setPermissionMode(mode: PermissionMode): void {
    this.state.permissionMode = mode;
  }

  async setModel(model: string): Promise<void> {
    await this.lifecycle.ensureInitialized();
    await this.state.getAgent().setModel(model);
    this.state.options.model = model;
    this.state.logger.debug(`[Session] Updated model to ${model}`);
  }

  setMaxTurns(maxTurns: number): void {
    this.state.maxTurns = maxTurns;
  }

  async supportedModels(): Promise<ModelInfo[]> {
    return [
      {
        id: 'default',
        name: this.state.options.model,
        provider: this.state.options.provider.id?.trim() || this.state.options.provider.type,
      },
    ];
  }

  async mcpServerStatus(): Promise<McpServerStatus[]> {
    await this.lifecycle.ensureInitialized();
    return this.state.getRuntime().mcpServerStatus();
  }

  async mcpConnect(serverName: string): Promise<void> {
    await this.lifecycle.ensureInitialized();
    await this.state.getRuntime().mcpConnect(serverName);
    this.state.logger.debug(`[Session] Connected to MCP server: ${serverName}`);
  }

  async mcpDisconnect(serverName: string): Promise<void> {
    await this.lifecycle.ensureInitialized();
    await this.state.getRuntime().mcpDisconnect(serverName);
    this.state.logger.debug(`[Session] Disconnected from MCP server: ${serverName}`);
  }

  async mcpReconnect(serverName: string): Promise<void> {
    await this.lifecycle.ensureInitialized();
    await this.state.getRuntime().mcpReconnect(serverName);
    this.state.logger.debug(`[Session] Reconnected to MCP server: ${serverName}`);
  }

  async mcpListTools(): Promise<McpToolInfo[]> {
    await this.lifecycle.ensureInitialized();
    return this.state.getRuntime().mcpListTools();
  }

  async fork(options?: ForkSessionOptions): Promise<ISession> {
    await this.lifecycle.ensureInitialized();
    const snapshot = this.state.persistenceEnabled
      ? await this.state.runWithExecutionLease(() =>
          this.state.store.forkState(this.state.sessionId, {
            messageId: options?.messageId,
          }),
        )
      : this.state.createSnapshotFromMessages(options?.messageId);

    const forkedSession = new AgentSession(
      {
        ...this.state.options,
        defaultContext: this.state.defaultContext,
      },
      undefined,
      false,
      this.state.hostProfile,
      {
        source: 'fork',
        parentSessionId: this.state.sessionId,
      },
    );
    await forkedSession.initialize();
    forkedSession.state.messages = this.state.cloneSnapshotMessages(snapshot);

    this.state.logger.debug(
      `[Session] Forked session ${this.state.sessionId} -> ${forkedSession.sessionId} with ${forkedSession.state.messages.length} messages`,
    );

    return forkedSession;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
