import { nanoid } from 'nanoid';
import type { JsonObject, McpServerConfig, ModelConfig, PermissionsConfig } from '../types/common.js';
import type { SubagentConfig, SubagentContext, SubagentResult } from './types.js';
import type { SubagentRegistry } from './SubagentRegistry.js';

export interface SubagentBladeConfig {
  models: ModelConfig[];
  currentModelId?: string;
  mcpServers?: Record<string, McpServerConfig>;
  inProcessMcpServerNames?: string[];
  permissions?: PermissionsConfig;
  theme?: string;
  language?: string;
  debug?: boolean | string;
  temperature?: number;
  maxTurns?: number;
  plansDirectory?: string;
  storageRoot?: string;
  [key: string]: JsonObject[keyof JsonObject] | ModelConfig[] | Record<string, McpServerConfig> | PermissionsConfig | undefined;
}

export type SubagentExecutionRunner = (input: {
  config: SubagentConfig;
  bladeConfig: SubagentBladeConfig;
  registry?: SubagentRegistry;
  context: SubagentContext;
  agentId: string;
  systemPrompt: string;
}) => Promise<SubagentResult>;

export class SubagentExecutor {
  constructor(
    private readonly config: SubagentConfig,
    private readonly bladeConfig: SubagentBladeConfig,
    private readonly subagentRegistry?: SubagentRegistry,
    private readonly runner: SubagentExecutionRunner = defaultSubagentRunner,
  ) {}

  async execute(context: SubagentContext): Promise<SubagentResult> {
    const startTime = Date.now();
    const agentId = context.subagentSessionId ?? nanoid();

    try {
      return await this.runner({
        config: this.config,
        bladeConfig: this.bladeConfig,
        registry: this.subagentRegistry,
        context,
        agentId,
        systemPrompt: this.buildSystemPrompt(),
      });
    } catch (error) {
      return {
        success: false,
        message: '',
        agentId,
        error: error instanceof Error ? error.message : String(error),
        stats: {
          duration: Date.now() - startTime,
        },
      };
    }
  }

  private buildSystemPrompt(): string {
    return this.config.systemPrompt || '';
  }
}

async function defaultSubagentRunner(): Promise<SubagentResult> {
  throw new Error(
    'SubagentExecutor requires a runtime runner in @blade-ai/agent-sdk. Use session agents or the local Task tool runtime for built-in subagent execution.',
  );
}
