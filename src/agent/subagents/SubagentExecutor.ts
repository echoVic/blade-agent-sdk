import { nanoid } from 'nanoid';
import type { BladeConfig } from '../config.js';
import type { IBackgroundAgentManager } from '../types.js';
import { runSubagent } from './runSubagent.js';
import type { SubagentRegistry } from './SubagentRegistry.js';
import type { SubagentConfig, SubagentContext, SubagentResult } from './types.js';

export class SubagentExecutor {
  constructor(
    private config: SubagentConfig,
    private bladeConfig: BladeConfig,
    private readonly subagentRegistry?: SubagentRegistry,
    private readonly backgroundAgentManager?: IBackgroundAgentManager,
  ) {}

  async execute(context: SubagentContext): Promise<SubagentResult> {
    const startTime = Date.now();
    const agentId = context.subagentSessionId ?? nanoid();

    try {
      const loopResult = await runSubagent({
        config: this.config,
        bladeConfig: this.bladeConfig,
        subagentRegistry: this.subagentRegistry,
        backgroundAgentManager: this.backgroundAgentManager,
        prompt: context.prompt,
        agentId,
        parentSessionId: context.parentSessionId,
        permissionMode: context.permissionMode,
        snapshot: context.snapshot,
        signal: context.signal,
        executionFence: context.executionFence,
        assertExecutionLease: context.assertExecutionLease,
        runWithExecutionLease: context.runWithExecutionLease,
        middleware: this.backgroundAgentManager?.getMiddleware?.(),
        providerRegistry: this.backgroundAgentManager?.getProviderRegistry?.(),
        omitEnvironment: context.omitEnvironment ?? this.config.omitEnvironment,
      });

      if (!loopResult.success) {
        throw new Error(loopResult.error?.message || 'Subagent execution failed');
      }

      const duration = Date.now() - startTime;

      return {
        success: true,
        message: loopResult.finalMessage || '',
        agentId,
        stats: {
          tokens: loopResult.metadata?.tokensUsed || 0,
          toolCalls: loopResult.metadata?.toolCallsCount || 0,
          duration,
        },
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      return {
        success: false,
        message: '',
        agentId,
        error: error instanceof Error ? error.message : String(error),
        stats: {
          duration,
        },
      };
    }
  }
}
