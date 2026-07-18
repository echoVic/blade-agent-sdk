import type { SubagentContext, SubagentResult } from '../subagents/types.js';

/**
 * SubagentRegistry 的最小接口定义
 *
 * 用于解耦 tools/builtin 与 agent/subagents 的具体实现
 */

export interface SubagentRegistryLike {
  loadFromStandardLocations(basePath?: string, configDir?: string): void;
}

/**
 * SubagentExecutorLike — 子代理执行器契约接口
 *
 * 定义子代理执行的单方法契约。
 * SubagentExecutor (root src/agent/subagents/SubagentExecutor.ts, 114L)
 * 负责执行子代理任务并返回结果。
 */
export interface SubagentExecutorLike {
  execute(context: SubagentContext): Promise<SubagentResult>;
}
