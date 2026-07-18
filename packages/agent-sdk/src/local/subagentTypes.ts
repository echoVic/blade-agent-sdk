/**
 * SubagentRegistry 的最小接口定义
 *
 * 用于解耦 tools/builtin 与 agent/subagents 的具体实现
 */

export interface SubagentRegistryLike {
  loadFromStandardLocations(basePath?: string, configDir?: string): void;
}
