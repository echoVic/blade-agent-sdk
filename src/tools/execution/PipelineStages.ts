import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../../logging/Logger.js';
import type { PermissionsConfig } from '../../types/common.js';
import { PermissionMode } from '../../types/common.js';
import type {
  CanUseTool,
  PermissionResult as CanUseToolResult,
  PermissionUpdate,
} from '../../types/permissions.js';
import { getErrorMessage } from '../../utils/errorUtils.js';
import type { Tool, ToolInvocation } from '../types/ToolTypes.js';

function getString(params: Record<string, unknown>, key: string, defaultValue = ''): string {
  const value = params[key];
  return typeof value === 'string' ? value : defaultValue;
}

enum PermissionResult {
  ALLOW = 'allow',
  DENY = 'deny',
  ASK = 'ask',
}

interface PermissionCheckResult {
  result: PermissionResult;
  matchedRule?: string;
  reason?: string;
}

interface ToolInvocationDescriptor {
  toolName: string;
  params: Record<string, unknown>;
  affectedPaths: string[];
  tool?: { name: string; extractSignatureContent?: (params: unknown) => string; abstractPermissionRule?: (params: unknown) => string };
}

class PermissionChecker {
  constructor(private config: PermissionsConfig) {}

  static buildSignature(descriptor: ToolInvocationDescriptor): string {
    if (descriptor.tool?.extractSignatureContent) {
      return `${descriptor.toolName}:${descriptor.tool.extractSignatureContent(descriptor.params)}`;
    }
    return descriptor.toolName;
  }

  static abstractPattern(descriptor: ToolInvocationDescriptor): string {
    if (descriptor.tool?.abstractPermissionRule) {
      return `${descriptor.toolName}:${descriptor.tool.abstractPermissionRule(descriptor.params)}`;
    }
    return `${descriptor.toolName}:*`;
  }

  check(descriptor: ToolInvocationDescriptor): PermissionCheckResult {
    const signature = PermissionChecker.buildSignature(descriptor);
    
    if (this.config.deny?.some(rule => this.matchRule(signature, rule))) {
      return { result: PermissionResult.DENY, matchedRule: 'deny', reason: 'Denied by permission rule' };
    }
    
    if (this.config.allow?.some(rule => this.matchRule(signature, rule))) {
      return { result: PermissionResult.ALLOW, matchedRule: 'allow', reason: 'Allowed by permission rule' };
    }
    
    if (this.config.ask?.some(rule => this.matchRule(signature, rule))) {
      return { result: PermissionResult.ASK, matchedRule: 'ask', reason: 'Requires user confirmation' };
    }
    
    return { result: PermissionResult.ASK, reason: 'Default: requires user confirmation' };
  }

  replaceConfig(config: PermissionsConfig): void {
    this.config = { ...this.config, ...config };
  }

  private matchRule(signature: string, rule: string): boolean {
    if (rule === '*') return true;
    if (rule.endsWith('*')) {
      return signature.startsWith(rule.slice(0, -1));
    }
    return signature === rule;
  }
}

import type { ToolRegistry } from '../registry/ToolRegistry.js';
import type { PipelineStage, ToolExecution } from '../types/index.js';
import { isReadOnlyKind, ToolKind } from '../types/index.js';
import {
  SensitiveFileDetector,
  SensitivityLevel,
} from '../validation/SensitiveFileDetector.js';
import { DenialTracker } from './DenialTracker.js';

/**
 * 工具发现阶段
 * 负责从注册表中查找工具
 */
export class DiscoveryStage implements PipelineStage {
  readonly name = 'discovery';

  constructor(private registry: ToolRegistry) {}

  async process(execution: ToolExecution): Promise<void> {
    const tool = this.registry.get(execution.toolName);

    if (!tool) {
      execution.abort(`Tool "${execution.toolName}" not found`);
      return;
    }

    // 将工具实例附加到执行上下文中
    execution._internal.tool = tool;
  }
}

/**
 * 权限检查阶段
 * 负责检查工具执行权限并进行 Zod 参数验证
 *
 * 注意：参数验证(包括默认值处理)由 tool.build() 中的 Zod schema 完成
 */
export class PermissionStage implements PipelineStage {
  readonly name = 'permission';
  private permissionChecker: PermissionChecker;
  private readonly sessionApprovals: Set<string>;
  // 🔧 重命名为 defaultPermissionMode，作为回退值
  // 实际权限检查时优先使用 execution.context.permissionMode（动态值）
  private readonly defaultPermissionMode: PermissionMode;

  constructor(
    permissionConfig: PermissionsConfig,
    sessionApprovals: Set<string>,
    permissionMode: PermissionMode,
    private readonly logger: InternalLogger = NOOP_LOGGER.child(LogCategory.EXECUTION),
  ) {
    this.permissionChecker = new PermissionChecker(permissionConfig);
    this.sessionApprovals = sessionApprovals;
    this.defaultPermissionMode = permissionMode;
  }

  /**
   * 获取 PermissionChecker 实例（供 ConfirmationStage 使用）
   */
  getPermissionChecker(): PermissionChecker {
    return this.permissionChecker;
  }

  async process(execution: ToolExecution): Promise<void> {
    const tool = execution._internal.tool;
    if (!tool) {
      execution.abort('Discovery stage failed; cannot perform permission check');
      return;
    }

    try {
      // 创建工具调用实例
      const invocation = tool.build(execution.params);

      // 检查受影响的路径
      const affectedPaths = invocation.getAffectedPaths();

      // 构建工具调用描述符（包含工具实例用于权限系统）
      const descriptor: ToolInvocationDescriptor = {
        toolName: tool.name,
        params: execution.params,
        affectedPaths,
        tool, // 传递工具实例，用于 extractSignatureContent 和 abstractPermissionRule
      };
      const signature = PermissionChecker.buildSignature(descriptor);
      execution._internal.permissionSignature = signature;

      // 使用 PermissionChecker 进行权限检查
      let checkResult = this.permissionChecker.check(descriptor);
      // 从 execution.context 动态读取 permissionMode（现在是强类型 PermissionMode）
      // 这样 Shift+Tab 切换模式或 approve 后切换模式都能正确生效
      const currentPermissionMode =
        execution.context.permissionMode || this.defaultPermissionMode;
      checkResult = this.applyModeOverrides(
        tool.kind,
        checkResult,
        currentPermissionMode
      );

      // 根据检查结果采取行动
      switch (checkResult.result) {
        case PermissionResult.DENY:
          execution.abort(
            checkResult.reason ||
              `Tool invocation "${tool.name}" was denied by permission rules: ${checkResult.matchedRule}`
          );
          return;

        case PermissionResult.ASK:
          if (this.sessionApprovals.has(signature)) {
            checkResult = {
              result: PermissionResult.ALLOW,
              matchedRule: 'remembered:session',
              reason: 'User already allowed this operation in this session',
            };
          } else {
            // 标记需要用户确认
            execution._internal.needsConfirmation = true;
            execution._internal.confirmationReason =
              checkResult.reason || 'User confirmation required';
          }
          break;

        case PermissionResult.ALLOW:
          // 允许执行，继续
          break;
      }

      // 额外的安全检查: 检查危险路径和敏感文件
      if (affectedPaths.length > 0) {
        // 1. 检查危险系统路径
        const dangerousSystemPaths = [
          '/etc/',
          '/sys/',
          '/proc/',
          '/dev/',
          '/boot/',
          '/root/',
          'C:\\Windows\\System32',
          'C:\\Program Files',
          'C:\\ProgramData',
        ];

        const dangerousPaths = affectedPaths.filter((filePath: string) => {
          // 路径遍历攻击
          if (filePath.includes('..')) {
            return true;
          }

          // 危险系统目录（不再拒绝所有 / 开头的路径）
          return dangerousSystemPaths.some((dangerous) => filePath.includes(dangerous));
        });

        if (dangerousPaths.length > 0) {
          execution.abort(
            `Access to dangerous system paths denied: ${dangerousPaths.join(', ')}`
          );
          return;
        }

        // 2. 检查敏感文件
        const sensitiveFiles = SensitiveFileDetector.filterSensitive(
          affectedPaths,
          SensitivityLevel.MEDIUM // 默认检测中度及以上敏感文件
        );

        if (sensitiveFiles.length > 0) {
          // 构建敏感文件警告信息
          const warnings = sensitiveFiles.map(
            ({ path: filePath, result }) =>
              `${filePath} (${result.level}: ${result.reason})`
          );

          // 高度敏感文件直接拒绝（除非有明确的 allow 规则）
          const highSensitiveFiles = sensitiveFiles.filter(
            ({ result }) => result.level === SensitivityLevel.HIGH
          );

          if (
            highSensitiveFiles.length > 0 &&
            checkResult.result !== PermissionResult.ALLOW
          ) {
            execution.abort(
              `Access to highly sensitive files denied:\n${warnings.join('\n')}\n\nIf access is required, add an explicit allow rule in permissions.`
            );
            return;
          }

          // 中度敏感文件：需要用户确认（通过修改 checkResult）
          if (
            checkResult.result === PermissionResult.ALLOW &&
            sensitiveFiles.length > 0
          ) {
            // 即使被 allow 规则允许，也需要特别提示
            execution._internal.confirmationReason = `Sensitive file access detected:\n${warnings.join('\n')}\n\nConfirm to proceed?`;
            execution._internal.needsConfirmation = true;
          }
        }
      }

      // 将调用实例附加到执行上下文
      execution._internal.invocation = invocation;
      execution._internal.permissionCheckResult = checkResult;
    } catch (error) {
      execution.abort(`Permission check failed: ${getErrorMessage(error)}`);
    }
  }

  /**
   * 应用权限模式覆盖规则
   *
   * 权限模式行为：
   * - DEFAULT: ReadOnly 工具（Read/Glob/Grep/WebFetch/WebSearch/TaskOutput/TodoWrite/Plan）自动批准，其他需要确认
   * - AUTO_EDIT: ReadOnly + Write 工具自动批准，其他需要确认
   * - YOLO: 所有工具自动批准
   * - PLAN: 仅 ReadOnly 工具允许，其他全部拒绝
   *
   * ReadOnly 工具（包括 TodoWrite）在所有模式下都自动批准，因为它们：
   * - 无副作用（仅读取或操作内存状态）
   * - 不直接修改文件系统
   * - 用户可见且安全
   *
   * 优先级：YOLO 模式 > PLAN 模式 > DENY 规则 > ALLOW 规则 > 模式规则 > ASK
   *
   * @param permissionMode - 当前权限模式（从 execution.context 动态读取）
   */
  private applyModeOverrides(
    toolKind: ToolKind,
    checkResult: PermissionCheckResult,
    permissionMode: PermissionMode
  ): PermissionCheckResult {
    // 1. YOLO 模式：完全放开，批准所有工具（最高优先级）
    if (permissionMode === PermissionMode.YOLO) {
      return {
        result: PermissionResult.ALLOW,
        matchedRule: 'mode:yolo',
        reason: 'YOLO mode: automatically approve all tool invocations',
      };
    }

    // 2. PLAN 模式：严格拒绝非只读工具
    if (permissionMode === PermissionMode.PLAN) {
      if (!isReadOnlyKind(toolKind)) {
        return {
          result: PermissionResult.DENY,
          matchedRule: 'mode:plan',
          reason:
            'Plan mode: modification tools are blocked; only read-only tools are allowed (Read/Glob/Grep/WebFetch/WebSearch/Task)',
        };
      }
    }

    // 3. 如果已被 deny 规则拒绝，不覆盖
    if (checkResult.result === PermissionResult.DENY) {
      return checkResult;
    }

    // 4. 如果已被 allow 规则批准，不覆盖
    if (checkResult.result === PermissionResult.ALLOW) {
      return checkResult;
    }

    // 5. 只读工具：所有模式下都自动批准
    if (isReadOnlyKind(toolKind)) {
      return {
        result: PermissionResult.ALLOW,
        matchedRule: `mode:${permissionMode}:readonly`,
        reason: 'Read-only tools do not require confirmation',
      };
    }

    // 6. AUTO_EDIT 模式：额外批准 Write 工具
    if (permissionMode === PermissionMode.AUTO_EDIT && toolKind === ToolKind.Write) {
      return {
        result: PermissionResult.ALLOW,
        matchedRule: 'mode:autoEdit:write',
        reason: 'AUTO_EDIT mode: automatically approve write tools',
      };
    }

    // 7. 其他情况：保持原检查结果（通常是 ASK）
    return checkResult;
  }
}

/**
 * 用户确认阶段
 * 使用 canUseTool 函数进行权限决策
 *
 * 确认触发条件:
 * - PermissionStage 标记 needsConfirmation = true (权限规则要求)
 * - 或者提供了 canUseTool 函数
 */
export class ConfirmationStage implements PipelineStage {
  readonly name = 'confirmation';

  constructor(
    private readonly sessionApprovals: Set<string>,
    private readonly permissionChecker: PermissionChecker,
    private readonly canUseTool?: CanUseTool,
    private readonly logger: InternalLogger = NOOP_LOGGER.child(LogCategory.EXECUTION),
    private readonly denialTracker?: DenialTracker,
  ) {}

  async process(execution: ToolExecution): Promise<void> {
    const { tool, invocation, needsConfirmation } = execution._internal;

    if (!tool || !invocation) {
      execution.abort('Pre-confirmation stage failed; cannot request user approval');
      return;
    }

    const affectedPaths = invocation.getAffectedPaths() || [];

    if (this.canUseTool) {
      const result = await this.canUseTool(tool.name, execution.params, {
        signal: execution.context.signal || new AbortController().signal,
        toolKind: tool.kind,
        affectedPaths,
      });

      await this.handleCanUseToolResult(result, execution);
      return;
    }

    if (!needsConfirmation) {
      return;
    }

    await this.handleLegacyConfirmation(execution, tool, invocation, affectedPaths);
  }

  private async handleCanUseToolResult(
    result: CanUseToolResult,
    execution: ToolExecution
  ): Promise<void> {
    const { tool, invocation } = execution._internal;

    switch (result.behavior) {
      case 'allow':
        if (result.updatedInput) {
          Object.assign(execution.params, result.updatedInput);
          if (tool && invocation) {
            execution._internal.invocation = tool.build(execution.params);
          }
        }
        if (result.updatedPermissions) {
          this.applyPermissionUpdates(result.updatedPermissions);
        }
        this.logger.debug(`canUseTool allowed: ${execution.toolName}`);
        break;

      case 'deny':
        if (this.denialTracker && execution._internal.permissionSignature) {
          this.denialTracker.record(
            execution._internal.permissionSignature,
            execution.toolName,
            result.message || 'Denied by canUseTool'
          );
        }
        execution.abort(result.message, { shouldExitLoop: result.interrupt });
        break;

      case 'ask':
        execution._internal.needsConfirmation = true;
        if (tool && invocation) {
          await this.handleLegacyConfirmation(
            execution,
            tool,
            invocation,
            invocation.getAffectedPaths() || []
          );
        }
        break;
    }
  }

  private applyPermissionUpdates(updates: PermissionUpdate[]): void {
    for (const update of updates) {
      switch (update.type) {
        case 'addRules':
          for (const rule of update.rules) {
            const ruleStr = rule.ruleContent
              ? `${rule.toolName}:${rule.ruleContent}`
              : rule.toolName;
            if (update.behavior === 'allow') {
              this.sessionApprovals.add(ruleStr);
            }
            this.logger.debug(`Permission rule added: ${ruleStr} -> ${update.behavior}`);
          }
          break;

        case 'removeRules':
          for (const rule of update.rules) {
            const ruleStr = rule.ruleContent
              ? `${rule.toolName}:${rule.ruleContent}`
              : rule.toolName;
            this.sessionApprovals.delete(ruleStr);
            this.logger.debug(`Permission rule removed: ${ruleStr}`);
          }
          break;
      }
    }
  }

  private async handleLegacyConfirmation(
    execution: ToolExecution,
    tool: Tool<unknown>,
    invocation: ToolInvocation<unknown>,
    affectedPaths: string[]
  ): Promise<void> {
    const { confirmationReason, permissionCheckResult } = execution._internal;

    try {
      const signature = tool.extractSignatureContent
        ? tool.extractSignatureContent(execution.params)
        : tool.name;

      const confirmationDetails = {
        title: `权限确认: ${signature}`,
        message: confirmationReason || '此操作需要用户确认',
        kind: tool.kind,
        details: this.generatePreviewForTool(tool.name, execution.params),
        risks: this.extractRisksFromPermissionCheck(tool, execution.params, permissionCheckResult),
        affectedFiles: affectedPaths,
      };

      this.logger.warn(`工具 "${tool.name}" 需要用户确认: ${confirmationDetails.title}`);

      const confirmationHandler = execution.context.confirmationHandler;
      if (confirmationHandler) {
        this.logger.info(`[ConfirmationStage] Requesting confirmation for ${tool.name}`);
        const response = await confirmationHandler.requestConfirmation(confirmationDetails);
        this.logger.info(`[ConfirmationStage] Confirmation response: approved=${response.approved}`);

        if (!response.approved) {
          const reason = response.reason || 'User rejected';
          if (this.denialTracker && execution._internal.permissionSignature) {
            this.denialTracker.record(
              execution._internal.permissionSignature,
              tool.name,
              reason
            );
          }
          execution.abort(
            `User rejected execution: ${reason}`,
            { shouldExitLoop: true }
          );
          return;
        }

        const scope = response.scope || 'once';
        if (scope === 'session' && execution._internal.permissionSignature) {
          this.sessionApprovals.add(execution._internal.permissionSignature);
        }
      } else {
        this.logger.warn('⚠️ No ConfirmationHandler; auto-approving tool execution');
      }
    } catch (error) {
      execution.abort(`User confirmation failed: ${getErrorMessage(error)}`);
    }
  }

  private generatePreviewForTool(
    toolName: string,
    params: Record<string, unknown>
  ): string | undefined {
    switch (toolName) {
      case 'Edit': {
        const oldString = getString(params, 'old_string');
        const newString = getString(params, 'new_string');
        if (!oldString && !newString) return undefined;

        const maxLines = 20;
        const truncate = (text: string): string => {
          const lines = text.split('\n');
          if (lines.length <= maxLines) return text;
          return `${lines.slice(0, maxLines).join('\n')}\n... (还有 ${lines.length - maxLines} 行)`;
        };

        return `**变更前:**\n\`\`\`\n${truncate(oldString || '(空)')}\n\`\`\`\n\n**变更后:**\n\`\`\`\n${truncate(newString || '(删除)')}\n\`\`\``;
      }

      case 'Write': {
        const content = getString(params, 'content');
        const encoding = getString(params, 'encoding', 'utf8');
        if (encoding !== 'utf8' || !content) {
          return `将写入 ${encoding === 'base64' ? 'Base64 编码' : encoding === 'binary' ? '二进制' : ''} 内容`;
        }

        const maxLines = 30;
        const lines = content.split('\n');
        if (lines.length <= maxLines) {
          return `**文件内容预览:**\n\`\`\`\n${content}\n\`\`\``;
        }

        const preview = lines.slice(0, maxLines).join('\n');
        return `**文件内容预览 (前 ${maxLines} 行):**\n\`\`\`\n${preview}\n\`\`\`\n\n... (还有 ${lines.length - maxLines} 行)`;
      }

      default:
        return undefined;
    }
  }

  private extractRisksFromPermissionCheck(
    tool: { name: string },
    params: Record<string, unknown>,
    permissionCheckResult?: { reason?: string }
  ): string[] {
    const risks: string[] = [];

    if (permissionCheckResult?.reason) {
      risks.push(permissionCheckResult.reason);
    }

    if (tool.name === 'Bash') {
      const command = getString(params, 'command');
      const mainCommand = command.trim().split(/\s+/)[0];

      if (['cat', 'head', 'tail'].includes(mainCommand)) {
        risks.push(`💡 建议使用 Read 工具代替 ${mainCommand} 命令`);
      } else if (['grep', 'rg'].includes(mainCommand)) {
        risks.push('💡 建议使用 Grep 工具代替 grep/rg 命令');
      } else if (mainCommand === 'find') {
        risks.push('💡 建议使用 Glob 工具代替 find 命令');
      } else if (['sed', 'awk'].includes(mainCommand)) {
        risks.push(`💡 建议使用 Edit 工具代替 ${mainCommand} 命令`);
      }

      if (command.includes('rm')) risks.push('⚠️ 此命令可能删除文件');
      if (command.includes('sudo')) risks.push('⚠️ 此命令需要管理员权限');
      if (command.includes('git push')) risks.push('⚠️ 此命令将推送代码到远程仓库');
    } else if (['Write', 'Edit'].includes(tool.name)) {
      risks.push('此操作将修改文件内容');
    } else if (tool.name === 'Delete') {
      risks.push('此操作将永久删除文件');
    }

    return risks;
  }
}

/**
 * 实际执行阶段
 * 负责执行工具
 */
export class ExecutionStage implements PipelineStage {
  readonly name = 'execution';

  async process(execution: ToolExecution): Promise<void> {
    const invocation = execution._internal.invocation;

    if (!invocation) {
      execution.abort('Pre-execution stage failed; cannot run tool');
      return;
    }

    try {
      // 执行工具，传递完整的执行上下文
      const result = await invocation.execute(
        execution.context.signal ?? new AbortController().signal,
        execution.context.onProgress,
        execution.context // 传递完整 context（包含 confirmationHandler、permissionMode 等）
      );

      execution.setResult(result);
    } catch (error) {
      execution.abort(`Tool execution failed: ${getErrorMessage(error)}`);
    }
  }
}

/**
 * 结果格式化阶段
 * 负责格式化执行结果
 */
export class FormattingStage implements PipelineStage {
  readonly name = 'formatting';

  async process(execution: ToolExecution): Promise<void> {
    try {
      const result = execution.getResult();

      // 确保结果格式正确
      if (!result.llmContent) {
        result.llmContent = 'Execution completed';
      }

      if (!result.displayContent) {
        result.displayContent = result.success ? '执行成功' : '执行失败';
      }

      // 添加执行元数据
      if (!result.metadata) {
        result.metadata = {};
      }

      result.metadata.executionId = execution.context.sessionId;
      result.metadata.toolName = execution.toolName;
      result.metadata.timestamp = Date.now();

      execution.setResult(result);
    } catch (error) {
      execution.abort(`Result formatting failed: ${getErrorMessage(error)}`);
    }
  }
}
