/**
 * Hook Output Parser
 *
 * 解析 Hook 命令的输出
 */

import type { JsonValue } from '../types/json.js';
import { safeParseHookOutput } from './schemas/HookSchemas.js';
import {
  type Hook,
  type HookConfig,
  type HookExecutionResult,
  HookExitCode,
  type HookOutput,
  type ProcessResult,
} from './types.js';

const VALID_EXIT_CODES = new Set(
  Object.values(HookExitCode).filter((v): v is number => typeof v === 'number'),
);

function toHookExitCode(code: number): HookExitCode {
  if (VALID_EXIT_CODES.has(code)) {
    return code;
  }
  return code >= 2 ? HookExitCode.BLOCKING_ERROR : HookExitCode.NON_BLOCKING_ERROR;
}

/**
 * 输出解析器
 */
export class OutputParser {
  /**
   * 解析进程结果
   */
  parse(
    result: ProcessResult,
    hook: Hook,
    config?: Pick<HookConfig, 'timeoutBehavior' | 'failureBehavior'>,
  ): HookExecutionResult {
    // 1. 超时 - 根据 timeoutBehavior 配置处理
    if (result.timedOut) {
      return this.buildFailureResult(
        config?.timeoutBehavior || 'ignore',
        'Hook timeout',
        result,
        hook,
        result.exitCode,
      );
    }

    // 2. 尝试解析 JSON 输出
    const jsonOutput = this.tryParseJSON(result.stdout);

    if (jsonOutput) {
      // 验证 JSON 结构
      const validation = safeParseHookOutput(jsonOutput);

      if (!validation.success) {
        // 验证失败 - 根据 failureBehavior 配置处理
        const errorMsg =
          'error' in validation ? validation.error.message : 'Unknown validation error';
        return this.buildFailureResult(
          config?.failureBehavior || 'ignore',
          `Invalid hook output JSON: ${errorMsg}`,
          result,
          hook,
          result.exitCode,
        );
      }

      const output = validation.data as HookOutput;

      // 检查 decision.behavior
      if (output.decision?.behavior === 'block') {
        return {
          status: 'blocked',
          error: output.systemMessage || 'Hook blocked execution',
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          hook,
        };
      }

      // async behavior - 不阻塞
      if (output.decision?.behavior === 'async') {
        return {
          status: 'success',
          output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          hook,
        };
      }

      // approve - 成功
      return {
        status: 'success',
        output,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        hook,
      };
    }

    // 3. 非 JSON 输出,根据退出码判断
    return this.parseByExitCode(result, hook, config);
  }

  /**
   * 根据退出码解析
   */
  private parseByExitCode(
    result: ProcessResult,
    hook: Hook,
    config?: Pick<HookConfig, 'timeoutBehavior' | 'failureBehavior'>,
  ): HookExecutionResult {
    const exitCode = toHookExitCode(result.exitCode);

    switch (exitCode) {
      case 0: // SUCCESS
        return {
          status: 'success',
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode,
          hook,
        };

      case 2: // BLOCKING_ERROR
        return {
          status: 'blocked',
          error: result.stderr || result.stdout || 'Hook returned exit code 2',
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode,
          hook,
        };

      case 124: {
        // TIMEOUT - 根据 timeoutBehavior 配置处理
        return this.buildFailureResult(
          config?.timeoutBehavior || 'ignore',
          'Hook timeout',
          result,
          hook,
          exitCode,
        );
      }

      default: {
        // NON_BLOCKING_ERROR - 根据 failureBehavior 配置处理
        const errorMsg = result.stderr || result.stdout || `Hook failed with exit code ${exitCode}`;
        return this.buildFailureResult(
          config?.failureBehavior || 'ignore',
          errorMsg,
          result,
          hook,
          exitCode,
        );
      }
    }
  }

  /**
   * 根据行为策略（deny/ask/ignore）构建失败结果。
   * 统一处理超时、JSON 校验失败、非零退出码等场景的三态分派。
   */
  private buildFailureResult(
    behavior: 'ignore' | 'deny' | 'ask',
    errorMsg: string,
    result: ProcessResult,
    hook: Hook,
    exitCode?: number,
  ): HookExecutionResult {
    const common = {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode,
      hook,
    };

    if (behavior === 'deny') {
      return { status: 'blocked', error: errorMsg, ...common };
    }

    if (behavior === 'ask') {
      return {
        status: 'needs_confirmation',
        warning: `${errorMsg}. Continue?`,
        ...common,
      };
    }

    return { status: 'warning', warning: errorMsg, ...common };
  }

  /**
   * 尝试解析 JSON
   */
  private tryParseJSON(text: string): JsonValue | null {
    try {
      const trimmed = text.trim();
      if (!trimmed) return null;

      // 只解析第一个完整的 JSON 对象
      const match = trimmed.match(/^\s*(\{[\s\S]*\})\s*$/);
      if (!match) return null;

      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }
}
