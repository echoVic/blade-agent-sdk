import { SessionId } from '../../types/branded.js';
import type { BladeConfig, PermissionMode } from '../../types/common.js';
import type { ContextSnapshot } from '../../runtime/index.js';
import type { Message } from '../../services/ChatServiceInterface.js';
import { Agent } from '../Agent.js';
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
  messages?: Message[];
  signal?: AbortSignal;
  backgroundAgentManager?: BackgroundAgentManager;
  omitEnvironment?: boolean;
  onProgress?: (progress: AgentProgress) => void;
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
    omitEnvironment,
    onProgress,
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
    },
  );

  const loopOptions = signal || onProgress
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
    subagentInfo: {
      parentSessionId: parentSessionId ?? '',
      subagentType: config.name,
      isSidechain: true,
    },
    omitEnvironment,
  };

  return loopOptions
    ? agent.runAgenticLoop(prompt, chatContext, loopOptions)
    : agent.runAgenticLoop(prompt, chatContext);
}
