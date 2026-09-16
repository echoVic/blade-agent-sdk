import { nanoid } from 'nanoid';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import type { AgentMiddlewareConfig } from '../../middleware/AgentPlugin.js';
import type { ConversationMessage } from '../../model/conversation.js';
import type { ContextSnapshot } from '../../runtime/index.js';
import type { ProviderRegistry } from '../../services/ProviderRegistry.js';
import {
  type DurableExecutionFence,
  DurableExecutionLeaseError,
} from '../../session/events/DurableExecutionLeaseStore.js';
import type { PermissionMode } from '../../types/constants.js';
import { AgentId, type SessionId } from '../../types/identifiers.js';
import type { BladeConfig } from '../config.js';
import type { AgentSessionRepository } from './AgentSessionRepository.js';
import type { AgentSession } from './AgentSessionStore.js';
import { type RunSubagentOptions, runSubagent } from './runSubagent.js';
import type { SubagentRegistry } from './SubagentRegistry.js';
import type { SubagentConfig, SubagentResult } from './types.js';

const DEFAULT_BACKGROUND_AGENT_SHUTDOWN_TIMEOUT_MS = 30_000;

interface BackgroundAgentRuntime {
  id: string;
  promise: Promise<SubagentResult>;
  lifecycleController: AbortController;
  workController: AbortController;
  startTime: number;
  executionFence?: DurableExecutionFence;
  runWithExecutionLease?: <T>(operation: () => Promise<T>) => Promise<T>;
}

export interface StartBackgroundAgentOptions {
  config: SubagentConfig;
  bladeConfig: BladeConfig;
  subagentRegistry?: SubagentRegistry;
  description: string;
  prompt: string;
  parentSessionId?: string;
  permissionMode?: PermissionMode;
  agentId?: AgentId;
  existingMessages?: ConversationMessage[];
  snapshot?: ContextSnapshot;
  executionFence?: DurableExecutionFence;
  assertExecutionLease?: () => Promise<void>;
  runWithExecutionLease?: <T>(operation: () => Promise<T>) => Promise<T>;
}

export class BackgroundAgentManager {
  private logger: InternalLogger = NOOP_LOGGER.child(LogCategory.AGENT);

  private runningAgents = new Map<AgentId, BackgroundAgentRuntime>();
  private acceptingNewAgents = true;
  private sessionStore: AgentSessionRepository;
  private readonly middleware: AgentMiddlewareConfig;

  constructor(
    sessionStore: AgentSessionRepository,
    logger?: InternalLogger,
    private readonly ownerSessionId?: SessionId,
    middleware: AgentMiddlewareConfig = {},
    private readonly providerRegistry?: ProviderRegistry,
  ) {
    this.sessionStore = sessionStore;
    this.middleware = {
      model: [...(middleware.model ?? [])],
      tool: [...(middleware.tool ?? [])],
    };
    if (logger) {
      this.logger = logger.child(LogCategory.AGENT);
      this.sessionStore.setLogger?.(logger);
    }
    void this.cleanupOrphanedSessions().catch((error: unknown) => {
      this.logger.warn('Failed to clean up orphaned agent sessions', error);
    });
  }

  static create(
    logger: InternalLogger,
    sessionStore: AgentSessionRepository,
    ownerSessionId?: SessionId,
    middleware?: AgentMiddlewareConfig,
    providerRegistry?: ProviderRegistry,
  ): BackgroundAgentManager {
    return new BackgroundAgentManager(
      sessionStore,
      logger,
      ownerSessionId,
      middleware,
      providerRegistry,
    );
  }

  setLogger(logger: InternalLogger): void {
    this.logger = logger.child(LogCategory.AGENT);
    this.sessionStore.setLogger?.(logger);
  }

  getMiddleware(): AgentMiddlewareConfig {
    return this.middleware;
  }

  getProviderRegistry(): ProviderRegistry | undefined {
    return this.providerRegistry;
  }

  private async cleanupOrphanedSessions(): Promise<void> {
    const sessions = await this.sessionStore.listSessions();
    const now = Date.now();
    const maxOrphanAge = 30 * 60 * 1000;

    for (const session of sessions) {
      if (session.status === 'running' && !session.executionFence) {
        // The repository can be shared by several runtimes. A Session that does
        // not belong to this manager's parent is another runtime's live work,
        // not an orphan; only this owner's own descendants may be declared
        // failed by this startup. Cross-process ownership still needs a lease
        // protocol — fencing records are skipped for the same reason.
        if (this.ownerSessionId !== undefined && session.parentSessionId !== this.ownerSessionId) {
          continue;
        }
        const isInMemory = this.runningAgents.has(session.id);
        const age = now - session.lastActiveAt;

        if (!isInMemory || age > maxOrphanAge) {
          this.logger.warn(`Cleaning up orphaned agent session: ${session.id}`);
          await this.sessionStore.markCompleted(session.id, {
            success: false,
            message: '',
            error: 'Session was orphaned (process restart or timeout)',
          });
        }
      }
    }
  }

  async startBackgroundAgent(options: StartBackgroundAgentOptions): Promise<string> {
    if (!this.acceptingNewAgents) {
      if (options.executionFence) {
        throw this.executionFenceError(
          options.agentId,
          options.executionFence,
          'admission is closed',
        );
      }
      throw new Error('Background agent admission is closed for Session handoff');
    }

    const {
      config,
      bladeConfig,
      subagentRegistry,
      description,
      prompt,
      parentSessionId,
      permissionMode,
      agentId,
      existingMessages,
      snapshot,
      executionFence,
      assertExecutionLease,
      runWithExecutionLease,
    } = options;

    const id = agentId || AgentId(nanoid());
    const lifecycleController = new AbortController();
    const workController = new AbortController();
    lifecycleController.signal.addEventListener(
      'abort',
      () => {
        if (!workController.signal.aborted) {
          workController.abort(lifecycleController.signal.reason);
        }
      },
      { once: true },
    );

    const session: AgentSession = {
      id,
      subagentType: config.name,
      description,
      prompt,
      messages: existingMessages || [],
      status: 'running',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      parentSessionId,
      executionFence,
    };

    await this.runOwnedPersistence(executionFence, runWithExecutionLease, async () => {
      if (!(await this.sessionStore.saveSession(session))) {
        throw this.executionFenceError(id, executionFence, 'creation was rejected');
      }
    });
    await assertExecutionLease?.();
    if (!this.acceptingNewAgents) {
      if (executionFence) {
        throw this.executionFenceError(
          id,
          executionFence,
          'admission closed during ownership validation',
        );
      }
      throw new Error('Background agent admission closed during ownership validation');
    }

    const startTime = Date.now();
    const promise = Promise.resolve().then(() =>
      this.executeAgent(
        {
          config,
          bladeConfig,
          subagentRegistry,
          prompt,
          agentId: id,
          parentSessionId,
          permissionMode,
          messages: existingMessages,
          snapshot,
          signal: workController.signal,
          backgroundAgentManager: this,
          executionFence,
          assertExecutionLease,
          runWithExecutionLease,
          middleware: this.middleware,
          providerRegistry: this.providerRegistry,
          onProgress: (progress) =>
            this.saveProgress(id, progress, executionFence, runWithExecutionLease),
        },
        lifecycleController.signal,
      ),
    );

    this.runningAgents.set(id, {
      id,
      promise,
      lifecycleController,
      workController,
      startTime,
      executionFence,
      runWithExecutionLease,
    });

    promise.finally(() => {
      if (this.runningAgents.get(id)?.promise === promise) {
        this.runningAgents.delete(id);
      }
    });

    this.logger.info(`Background agent started: ${id} (${config.name})`);
    return id;
  }

  private async executeAgent(
    options: RunSubagentOptions,
    lifecycleSignal: AbortSignal,
  ): Promise<SubagentResult> {
    const startTime = Date.now();
    try {
      if (lifecycleSignal.aborted || options.signal?.aborted) {
        throw new Error('Agent execution was cancelled');
      }
      const loopResult = await runSubagent(options);
      const result: SubagentResult = loopResult.success
        ? {
            success: true,
            message: loopResult.finalMessage || '',
            agentId: options.agentId,
            stats: {
              tokens: loopResult.metadata?.tokensUsed || 0,
              toolCalls: loopResult.metadata?.toolCallsCount || 0,
              duration: Date.now() - startTime,
            },
          }
        : {
            success: false,
            message: '',
            agentId: options.agentId,
            error: loopResult.error?.message || 'Unknown error',
            stats: { duration: Date.now() - startTime },
          };
      await this.saveOutcome(options, lifecycleSignal, result);
      this.logger.info(
        `Background agent completed: ${options.agentId} (success=${result.success})`,
      );
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failure: SubagentResult = {
        success: false,
        message: '',
        agentId: options.agentId,
        error: errorMessage,
        stats: { duration: Date.now() - startTime },
      };
      try {
        await this.saveOutcome(options, lifecycleSignal, failure);
      } catch (persistenceError) {
        this.logger.warn(
          `Background agent ${options.agentId} failure could not be persisted`,
          persistenceError,
        );
      }
      this.logger.warn(`Background agent failed: ${options.agentId}`, error);
      return failure;
    }
  }

  private async saveProgress(
    agentId: AgentId,
    progress: Parameters<NonNullable<RunSubagentOptions['onProgress']>>[0],
    fence?: DurableExecutionFence,
    runWithLease?: <T>(operation: () => Promise<T>) => Promise<T>,
  ): Promise<void> {
    await this.runOwnedPersistence(fence, runWithLease, async () => {
      if (!(await this.sessionStore.updateRunningSession(agentId, { progress }, fence))) {
        throw this.executionFenceError(agentId, fence, 'progress was rejected');
      }
    });
  }

  private async saveOutcome(
    options: RunSubagentOptions,
    lifecycleSignal: AbortSignal,
    result: SubagentResult,
  ): Promise<void> {
    const { agentId, executionFence, runWithExecutionLease } = options;
    await this.runOwnedPersistence(executionFence, runWithExecutionLease, async () => {
      await this.sessionStore.updateRunningSession(
        AgentId(agentId),
        { messages: options.messages ?? [] },
        executionFence,
      );
      const cancelled =
        lifecycleSignal.aborted ||
        options.signal?.aborted ||
        (await this.sessionStore.loadSession(AgentId(agentId)))?.status === 'cancelled';
      const output = { success: result.success, message: result.message, error: result.error };
      const updated =
        cancelled && !result.success
          ? await this.sessionStore.markCancelled(
              AgentId(agentId),
              output,
              result.stats,
              executionFence,
            )
          : await this.sessionStore.markCompleted(
              AgentId(agentId),
              output,
              result.stats,
              executionFence,
            );
      if (!updated) {
        throw this.executionFenceError(AgentId(agentId), executionFence, 'completion was rejected');
      }
    });
  }

  async getAgent(agentId: AgentId): Promise<AgentSession | undefined> {
    return this.sessionStore.loadSession(agentId);
  }

  isRunning(agentId: AgentId): boolean {
    return this.runningAgents.has(agentId);
  }

  async waitForCompletion(agentId: AgentId, timeout = 30000): Promise<AgentSession | undefined> {
    const runtime = this.runningAgents.get(agentId);

    if (!runtime) {
      return this.sessionStore.loadSession(agentId);
    }

    if (timeout > 0) {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        timeoutHandle = setTimeout(() => resolve('timeout'), timeout);
      });
      const result = await Promise.race([runtime.promise, timeoutPromise]).finally(() =>
        clearTimeout(timeoutHandle),
      );

      if (result === 'timeout') {
        return this.sessionStore.loadSession(agentId);
      }
    } else {
      await runtime.promise;
    }

    return this.sessionStore.loadSession(agentId);
  }

  async resumeAgent(
    agentId: AgentId,
    newPrompt: string,
    config: SubagentConfig,
    bladeConfig: BladeConfig,
    parentSessionId?: string,
    permissionMode?: PermissionMode,
    subagentRegistry?: SubagentRegistry,
    description?: string,
    executionFence?: DurableExecutionFence,
    assertExecutionLease?: () => Promise<void>,
    runWithExecutionLease?: <T>(operation: () => Promise<T>) => Promise<T>,
  ): Promise<string | undefined> {
    const session = await this.sessionStore.loadSession(agentId);

    if (!session) {
      this.logger.warn(`Cannot resume agent ${agentId}: session not found`);
      return undefined;
    }

    if (this.isRunning(agentId)) {
      this.logger.warn(`Cannot resume agent ${agentId}: still running`);
      return undefined;
    }

    return this.startBackgroundAgent({
      config,
      bladeConfig,
      subagentRegistry,
      description: description ?? session.description,
      prompt: newPrompt,
      parentSessionId: parentSessionId || session.parentSessionId,
      permissionMode,
      agentId,
      existingMessages: session.messages,
      executionFence,
      assertExecutionLease,
      runWithExecutionLease,
    });
  }

  async killAgent(agentId: AgentId): Promise<boolean> {
    const runtime = this.runningAgents.get(agentId);

    if (!runtime) {
      const session = await this.sessionStore.loadSession(agentId);
      if (session && session.status === 'running') {
        if (session.executionFence) {
          return false;
        }
        await this.sessionStore.markCancelled(agentId);
      }
      return false;
    }

    runtime.lifecycleController.abort();

    await this.runOwnedPersistence(
      runtime.executionFence,
      runtime.runWithExecutionLease,
      async () => {
        if (
          !(await this.sessionStore.markCancelled(
            agentId,
            undefined,
            undefined,
            runtime.executionFence,
          ))
        ) {
          throw this.executionFenceError(
            agentId,
            runtime.executionFence,
            'cancellation was rejected',
          );
        }
      },
    );

    this.logger.info(`Background agent cancelled: ${agentId}`);
    return true;
  }

  getOwnerSessionId(): SessionId | undefined {
    return this.ownerSessionId;
  }

  getActiveAgentIds(): readonly AgentId[] {
    return [...this.runningAgents.keys()];
  }

  sealForHandoff(): void {
    this.acceptingNewAgents = false;
  }

  sealAndCancelAll(): readonly AgentId[] {
    this.sealForHandoff();
    const agentIds = this.getActiveAgentIds();
    for (const agentId of agentIds) {
      this.runningAgents.get(agentId)?.lifecycleController.abort();
    }
    return agentIds;
  }

  async sealCancelAndWait(
    timeoutMs = DEFAULT_BACKGROUND_AGENT_SHUTDOWN_TIMEOUT_MS,
  ): Promise<readonly AgentId[]> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new Error('Background agent shutdown timeout must be non-negative');
    }
    const agentIds = this.sealAndCancelAll();
    await Promise.all(agentIds.map((agentId) => this.waitForCompletion(agentId, timeoutMs)));
    const unsettledAgentIds = agentIds.filter((agentId) => this.runningAgents.has(agentId));
    if (unsettledAgentIds.length > 0) {
      throw new Error(
        `Timed out waiting for background agents to stop: ${unsettledAgentIds.join(', ')}`,
      );
    }
    return agentIds;
  }

  private async runOwnedPersistence<T>(
    executionFence: DurableExecutionFence | undefined,
    runWithExecutionLease: (<R>(operation: () => Promise<R>) => Promise<R>) | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (executionFence && !runWithExecutionLease) {
      throw new DurableExecutionLeaseError(
        'DURABLE_EXECUTION_LEASE_INVALID',
        'Fenced background agents require a lease persistence boundary',
        {
          sessionId: this.ownerSessionId,
          leaseId: executionFence.leaseId,
          fencingToken: executionFence.fencingToken,
        },
      );
    }
    return runWithExecutionLease ? runWithExecutionLease(operation) : operation();
  }

  private executionFenceError(
    agentId: AgentId | undefined,
    executionFence: DurableExecutionFence | undefined,
    detail: string,
  ): DurableExecutionLeaseError {
    return new DurableExecutionLeaseError(
      'DURABLE_EXECUTION_LEASE_LOST',
      `Execution fence for background agent ${agentId ?? 'unknown'} ${detail}`,
      {
        sessionId: this.ownerSessionId,
        leaseId: executionFence?.leaseId,
        fencingToken: executionFence?.fencingToken,
      },
    );
  }
}
