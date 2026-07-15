/**
 * Hook Configuration
 *
 * 默认配置和配置加载逻辑
 */

export interface HookConfig {
  /** 是否启用 hooks */
  enabled?: boolean;

  /** 默认超时 (秒) */
  defaultTimeout?: number;

  /** 超时行为 */
  timeoutBehavior?: 'ignore' | 'deny' | 'ask';

  /** 失败行为 */
  failureBehavior?: 'ignore' | 'deny' | 'ask';

  /** 最大并发 Hook 数 */
  maxConcurrentHooks?: number;

  // ========== 工具执行类 ==========
  PreToolUse?: any[];
  PostToolUse?: any[];
  PostToolUseFailure?: any[];
  PermissionRequest?: any[];

  // ========== 会话生命周期类 ==========
  UserPromptSubmit?: any[];
  SessionStart?: any[];
  SessionEnd?: any[];

  // ========== 控制流类 ==========
  Stop?: any[];
  SubagentStart?: any[];
  SubagentStop?: any[];
  TaskCompleted?: any[];

  // ========== 其他 ==========
  Notification?: any[];
  Compaction?: any[];

  // ========== 控制流扩展 ==========
  StopFailure?: any[];

  // ========== 压缩生命周期 ==========
  PreCompact?: any[];
  PostCompact?: any[];

  // ========== MCP 交互 ==========
  Elicitation?: any[];
  ElicitationResult?: any[];

  // ========== 配置 ==========
  ConfigChange?: any[];

  // ========== 环境 ==========
  CwdChanged?: any[];
  FileChanged?: any[];

  // ========== 指令 ==========
  InstructionsLoaded?: any[];
}

/**
 * 默认 Hook 配置
 * 与 Claude Code 对齐的完整配置
 */
export const DEFAULT_HOOK_CONFIG: Required<HookConfig> = {
  enabled: false, // 默认禁用,需要显式启用
  defaultTimeout: 60, // 60 秒
  timeoutBehavior: 'ignore', // 超时时忽略,继续执行
  failureBehavior: 'ignore', // 失败时忽略,继续执行
  maxConcurrentHooks: 5, // 最多 5 个并发 hook
  // 工具执行类
  PreToolUse: [],
  PostToolUse: [],
  PostToolUseFailure: [],
  PermissionRequest: [],
  // 会话生命周期类
  UserPromptSubmit: [],
  SessionStart: [],
  SessionEnd: [],
  // 控制流类
  Stop: [],
  SubagentStart: [],
  SubagentStop: [],
  TaskCompleted: [],
  // 其他
  Notification: [],
  Compaction: [],
  // 控制流扩展
  StopFailure: [],
  // 压缩生命周期
  PreCompact: [],
  PostCompact: [],
  // MCP 交互
  Elicitation: [],
  ElicitationResult: [],
  // 配置
  ConfigChange: [],
  // 环境
  CwdChanged: [],
  FileChanged: [],
  // 指令
  InstructionsLoaded: [],
};

/**
 * 合并配置
 */
export function mergeHookConfig(
  base: HookConfig,
  override: Partial<HookConfig>
): HookConfig {
  return {
    ...base,
    ...override,
    // 工具执行类
    PreToolUse: override.PreToolUse ?? base.PreToolUse,
    PostToolUse: override.PostToolUse ?? base.PostToolUse,
    PostToolUseFailure: override.PostToolUseFailure ?? base.PostToolUseFailure,
    PermissionRequest: override.PermissionRequest ?? base.PermissionRequest,
    // 会话生命周期类
    UserPromptSubmit: override.UserPromptSubmit ?? base.UserPromptSubmit,
    SessionStart: override.SessionStart ?? base.SessionStart,
    SessionEnd: override.SessionEnd ?? base.SessionEnd,
    // 控制流类
    Stop: override.Stop ?? base.Stop,
    SubagentStart: override.SubagentStart ?? base.SubagentStart,
    SubagentStop: override.SubagentStop ?? base.SubagentStop,
    TaskCompleted: override.TaskCompleted ?? base.TaskCompleted,
    // 其他
    Notification: override.Notification ?? base.Notification,
    Compaction: override.Compaction ?? base.Compaction,
    // 控制流扩展
    StopFailure: override.StopFailure ?? base.StopFailure,
    // 压缩生命周期
    PreCompact: override.PreCompact ?? base.PreCompact,
    PostCompact: override.PostCompact ?? base.PostCompact,
    // MCP 交互
    Elicitation: override.Elicitation ?? base.Elicitation,
    ElicitationResult: override.ElicitationResult ?? base.ElicitationResult,
    // 配置
    ConfigChange: override.ConfigChange ?? base.ConfigChange,
    // 环境
    CwdChanged: override.CwdChanged ?? base.CwdChanged,
    FileChanged: override.FileChanged ?? base.FileChanged,
    // 指令
    InstructionsLoaded: override.InstructionsLoaded ?? base.InstructionsLoaded,
  };
}

/**
 * 从环境变量解析配置
 */
export function parseEnvConfig(): Partial<HookConfig> {
  const config: Partial<HookConfig> = {};

  // BLADE_DISABLE_HOOKS
  if (process.env.BLADE_DISABLE_HOOKS === 'true') {
    config.enabled = false;
  }

  // BLADE_HOOK_TIMEOUT
  if (process.env.BLADE_HOOK_TIMEOUT) {
    const timeout = parseInt(process.env.BLADE_HOOK_TIMEOUT, 10);
    if (!Number.isNaN(timeout) && timeout > 0) {
      config.defaultTimeout = timeout;
    }
  }

  return config;
}
