import { ToolExecutionError } from '../../errors/ToolExecutionError.js';
import type { JsonObject } from '../../types/json.js';
import type { ExecutionContext } from '../types/execution.js';
import type { ToolExecution, ToolValidationError } from '../types/result.js';
import { validationErrorToToolResult } from '../types/result.js';
import type { ToolInvocation } from '../types/tool.js';

export class UnifiedToolInvocation<TParams = JsonObject> implements ToolInvocation<TParams> {
  private validationPassed = false;

  constructor(
    public readonly toolName: string,
    public readonly params: TParams,
    private readonly executeFn: (params: TParams, context: ExecutionContext) => ToolExecution,
    private readonly validateFn?: (
      params: TParams,
      context: ExecutionContext,
    ) => Promise<undefined | ToolValidationError> | undefined | ToolValidationError,
    private readonly descriptionFn?: (params: TParams) => string,
    private readonly affectedPathsFn?: (params: TParams) => string[],
  ) {}

  /**
   * 获取操作描述
   */
  getDescription(): string {
    if (this.descriptionFn) {
      return this.descriptionFn(this.params);
    }
    return `执行工具: ${this.toolName}`;
  }

  /**
   * 获取受影响的文件路径
   */
  getAffectedPaths(): string[] {
    if (this.affectedPathsFn) {
      return this.affectedPathsFn(this.params);
    }
    return [];
  }

  async validate(
    context: Partial<ExecutionContext> = {},
  ): Promise<ToolValidationError | undefined> {
    if (this.validationPassed || !this.validateFn) {
      return undefined;
    }

    const validationResult = await this.validateFn(this.params, {
      signal: context.signal,
      ...context,
    });

    if (!validationResult) {
      this.validationPassed = true;
      return undefined;
    }

    return validationResult;
  }

  /**
   * 执行工具
   * @param signal - 中止信号
   * @param context - 额外的执行上下文（包含 confirmationHandler、permissionMode 等）
   */
  async *execute(signal: AbortSignal, context?: Partial<ExecutionContext>): ToolExecution {
    // 合并基础 context 和额外字段
    const fullContext: ExecutionContext = {
      signal,
      ...context, // 包含 confirmationHandler, permissionMode, userId, sessionId 等
    };

    const validationError = await this.validate(fullContext);
    if (validationError) {
      return validationErrorToToolResult(validationError);
    }

    const execution = this.executeFn(this.params, fullContext);
    if (!isToolExecution(execution)) {
      throw new ToolExecutionError(this.toolName, 'execute() must return an AsyncGenerator');
    }

    return yield* execution;
  }
}

function isToolExecution(value: unknown): value is ToolExecution {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as { next?: unknown }).next === 'function'
  );
}
