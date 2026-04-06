import {
  type ExecutionContext,
  type ToolInvocation,
  type ToolResult,
  type ToolValidationError,
  validationErrorToToolResult,
} from '../types/index.js';

export class UnifiedToolInvocation<
  TParams = unknown,
  TResult extends ToolResult = ToolResult,
> implements ToolInvocation<TParams, TResult> {
  private validationPassed = false;

  constructor(
    public readonly toolName: string,
    public readonly params: TParams,
    private readonly executeFn: (
      params: TParams,
      context: ExecutionContext
    ) => Promise<TResult>,
    private readonly validateFn?: (
      params: TParams,
      context: ExecutionContext
    ) => Promise<void | ToolValidationError> | void | ToolValidationError,
    private readonly descriptionFn?: (params: TParams) => string,
    private readonly affectedPathsFn?: (params: TParams) => string[]
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
    context: Partial<ExecutionContext> = {}
  ): Promise<ToolValidationError | undefined> {
    if (this.validationPassed || !this.validateFn) {
      return undefined;
    }

    const validationResult = await this.validateFn(this.params, {
      signal: context.signal,
      updateOutput: context.updateOutput,
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
   * @param updateOutput - 输出更新回调
   * @param context - 额外的执行上下文（包含 confirmationHandler、permissionMode 等）
   */
  async execute(
    signal: AbortSignal,
    updateOutput?: (output: string) => void,
    context?: Partial<ExecutionContext>
  ): Promise<TResult> {
    // 合并基础 context 和额外字段
    const fullContext: ExecutionContext = {
      signal,
      updateOutput,
      ...context, // 包含 confirmationHandler, permissionMode, userId, sessionId 等
    };

    const validationError = await this.validate(fullContext);
    if (validationError) {
      return validationErrorToToolResult(validationError) as TResult;
    }

    return this.executeFn(this.params, fullContext);
  }
}
