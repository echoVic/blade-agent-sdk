/**
 * Secure Process Executor
 *
 * 安全地执行 Hook 子进程
 */

import { spawn } from 'node:child_process';
import {
  shellProcessSpawnOptions,
  terminateProcessTree,
} from '../tools/builtin/shell/processTree.js';
import {
  HookExitCode,
  type HookExecutionContext,
  type HookInput,
  type ProcessResult,
} from './types/HookTypes.js';

const DEFAULT_HOOK_PROCESS_TERMINATION_GRACE_MS = 1_000;

function isBrokenPipeError(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'EPIPE'
  );
}

/**
 * 流量限制器
 */
class StreamLimiter {
  private content = '';
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  append(data: string): void {
    if (this.content.length < this.maxSize) {
      const remaining = this.maxSize - this.content.length;
      this.content += data.substring(0, remaining);
    }
  }

  getContent(): string {
    return this.content;
  }

  isFull(): boolean {
    return this.content.length >= this.maxSize;
  }
}

/**
 * 安全进程执行器
 */
export class SecureProcessExecutor {
  private readonly MAX_STDOUT_SIZE = 1 * 1024 * 1024; // 1MB
  private readonly MAX_STDERR_SIZE = 1 * 1024 * 1024; // 1MB
  private readonly MAX_INPUT_SIZE = 100 * 1024; // 100KB

  constructor(
    private readonly terminationGraceMs = DEFAULT_HOOK_PROCESS_TERMINATION_GRACE_MS,
  ) {
    if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs <= 0) {
      throw new TypeError('Hook process termination grace must be a positive safe integer');
    }
  }

  /**
   * 执行命令
   */
  async execute(
    command: string,
    input: HookInput,
    context: HookExecutionContext,
    timeoutMs: number
  ): Promise<ProcessResult> {
    if (context.abortSignal?.aborted) {
      return this.createCancelledResult();
    }

    // 1. 验证输入大小
    const inputJson = JSON.stringify(input);
    if (inputJson.length > this.MAX_INPUT_SIZE) {
      throw new Error(
        `Hook input too large: ${inputJson.length} bytes (max ${this.MAX_INPUT_SIZE})`
      );
    }

    // 2. 创建受限环境变量
    const env = this.createSafeEnv(input);

    // 3. 启动子进程
    const child = spawn(command, [], {
      shell: true,
      env,
      cwd: context.projectDir,
      ...shellProcessSpawnOptions(),
    });

    // 4. 流量控制
    const stdout = new StreamLimiter(this.MAX_STDOUT_SIZE);
    const stderr = new StreamLimiter(this.MAX_STDERR_SIZE);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (data: string) => {
      stdout.append(data);
    });

    child.stderr.on('data', (data: string) => {
      stderr.append(data);
    });

    // 5. 等待完成、取消或超时
    return new Promise((resolve, reject) => {
      let settled = false;
      let termination: 'abort' | 'timeout' | 'input-error' | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let abortHandler: (() => void) | null = null;

      const cleanup = (): void => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        if (abortHandler && context.abortSignal) {
          context.abortSignal.removeEventListener('abort', abortHandler);
          abortHandler = null;
        }
      };
      const resolveOnce = (result: ProcessResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const rejectOnce = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const stop = (
        reason: 'abort' | 'timeout' | 'input-error',
        cause?: unknown,
      ): void => {
        if (settled || termination) {
          return;
        }
        termination = reason;
        cleanup();
        void terminateProcessTree(
          child.pid,
          child,
          this.terminationGraceMs,
        ).then(
          () => {
            if (reason === 'input-error') {
              rejectOnce(
                new Error(`Failed to write hook input: ${String(cause)}`, {
                  cause,
                }),
              );
              return;
            }
            resolveOnce(
              reason === 'timeout'
                ? {
                    stdout: stdout.getContent(),
                    stderr: stderr.getContent(),
                    exitCode: HookExitCode.TIMEOUT,
                    timedOut: true,
                  }
                : this.createCancelledResult(stdout.getContent()),
            );
          },
          rejectOnce,
        );
      };

      child.on('close', (code) => {
        if (termination) return;
        resolveOnce({
          stdout: stdout.getContent(),
          stderr: stderr.getContent(),
          exitCode: code ?? 1,
          timedOut: false,
        });
      });

      child.on('error', (error) => {
        if (termination && child.pid) {
          return;
        }
        rejectOnce(error);
      });
      child.stdin.on('error', (error) => {
        if (isBrokenPipeError(error)) {
          // Fast hooks may close stdin before the write completes. Their exit
          // status remains authoritative.
          return;
        }
        stop('input-error', error);
      });

      timeout = setTimeout(() => stop('timeout'), timeoutMs);

      if (context.abortSignal) {
        abortHandler = () => stop('abort');
        context.abortSignal.addEventListener('abort', abortHandler, { once: true });
        if (context.abortSignal.aborted) {
          abortHandler();
        }
      }

      if (!termination) {
        try {
          child.stdin.write(inputJson);
          child.stdin.end();
        } catch (error) {
          if (isBrokenPipeError(error)) {
            return;
          }
          stop('input-error', error);
        }
      }
    });
  }

  private createCancelledResult(stdout = ''): ProcessResult {
    return {
      stdout,
      stderr: 'Hook cancelled by abort signal',
      exitCode: HookExitCode.NON_BLOCKING_ERROR,
      timedOut: false,
    };
  }

  /**
   * 创建安全的环境变量
   */
  private createSafeEnv(input: HookInput): NodeJS.ProcessEnv {
    // 只暴露安全的环境变量
    return {
      // Blade 特定变量
      BLADE_PROJECT_DIR: input.project_dir,
      BLADE_SESSION_ID: input.session_id,
      BLADE_HOOK_EVENT: input.hook_event_name,
      BLADE_TOOL_NAME: ('tool_name' in input && typeof input.tool_name === 'string')
        ? input.tool_name
        : undefined,
      BLADE_TOOL_USE_ID: ('tool_use_id' in input && typeof input.tool_use_id === 'string')
        ? input.tool_use_id
        : undefined,

      // 保留必要的系统变量
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
      USER: process.env.USER || '',
      SHELL: process.env.SHELL || '/bin/sh',

      // 不传递敏感变量 (API keys, tokens, etc.)
    };
  }
}
