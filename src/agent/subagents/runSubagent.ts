import type { AgentMiddlewareConfig } from '../../middleware/AgentPlugin.js';
import type { ConversationMessage } from '../../model/conversation.js';
import type { ContextSnapshot } from '../../runtime/index.js';
import type { ProviderRegistry } from '../../services/ProviderRegistry.js';
import type { DurableExecutionFence } from '../../session/events/DurableExecutionLeaseStore.js';
import type { PermissionMode } from '../../types/constants.js';
import { SessionId } from '../../types/identifiers.js';
import { Agent } from '../Agent.js';
import type { BladeConfig } from '../config.js';
import type { AgentProgress, LoopResult } from '../types.js';
import type { BackgroundAgentManager } from './BackgroundAgentManager.js';
import type { SubagentRegistry } from './SubagentRegistry.js';
import type { SubagentConfig } from './types.js';

export interface RunSubagentOptions {
  config: SubagentConfig;
  bladeConfig: BladeConfig;
  subagentRegistry?: SubagentRegistry;
  prompt: string;
  agentId: string;
  parentSessionId?: string;
  permissionMode?: PermissionMode;
  snapshot?: ContextSnapshot;
  messages?: ConversationMessage[];
  signal?: AbortSignal;
  backgroundAgentManager?: BackgroundAgentManager;
  executionFence?: DurableExecutionFence;
  assertExecutionLease?: () => Promise<void>;
  runWithExecutionLease?: <T>(operation: () => Promise<T>) => Promise<T>;
  omitEnvironment?: boolean;
  onProgress?: (progress: AgentProgress) => void | Promise<void>;
  middleware?: AgentMiddlewareConfig;
  providerRegistry?: ProviderRegistry;
}

function resolveModelId(config: SubagentConfig): string | undefined {
  return config.model && config.model !== 'inherit' ? config.model : undefined;
}

/**
 * 创建子 Agent 并运行一轮 agentic loop。
 *
 * SubagentExecutor 和 BackgroundAgentManager 共用此函数，
 * 统一 modelId 推导、Agent.create 配置、subagentInfo 构造以及
 * systemPrompt 传递方式（统一通过 ChatContext 传入，而非已废弃的 AgentOptions）。
 */
export async function runSubagent(options: RunSubagentOptions): Promise<LoopResult> {
  const {
    config,
    bladeConfig,
    subagentRegistry,
    prompt,
    agentId,
    parentSessionId,
    permissionMode,
    snapshot,
    messages,
    signal,
    backgroundAgentManager,
    executionFence,
    assertExecutionLease,
    runWithExecutionLease,
    omitEnvironment,
    onProgress,
    middleware,
    providerRegistry,
  } = options;

  const agent = await Agent.create(
    bladeConfig,
    {
      toolWhitelist: config.tools,
      modelId: resolveModelId(config),
    },
    {
      subagentRegistry,
      backgroundAgentManager,
      defaultContext: snapshot ? snapshot.context : {},
      modelMiddleware: middleware?.model,
      toolMiddleware: middleware?.tool,
      providerRegistry,
    },
  );

  const loopOptions =
    signal || onProgress
      ? {
          ...(signal ? { signal } : {}),
          ...(onProgress ? { onProgress } : {}),
        }
      : undefined;

  const chatContext = {
    messages: messages ?? [],
    userId: 'subagent',
    sessionId: SessionId(agentId),
    snapshot,
    permissionMode,
    systemPrompt: config.systemPrompt || '',
    subagentInfo: parentSessionId
      ? {
          parentSessionId: SessionId(parentSessionId),
          subagentType: config.name,
          isSidechain: true,
        }
      : undefined,
    omitEnvironment,
    executionFence,
    assertExecutionLease,
    runWithExecutionLease,
  };

  try {
    return await (loopOptions
      ? agent.runAgenticLoop(prompt, chatContext, loopOptions)
      : agent.runAgenticLoop(prompt, chatContext));
  } finally {
    await agent.destroy();
  }
}
