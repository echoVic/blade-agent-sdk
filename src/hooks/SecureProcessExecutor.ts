/**
 * Secure Process Executor
 *
 * 安全地执行 Hook 子进程
 */

import {
  type ChildProcessWithoutNullStreams,
  spawn,
} from 'node:child_process';
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
import {
  HookProcessContainmentError,
  isHookProcessContainmentError,
  WindowsProcessJob,
} from './WindowsProcessJob.js';

const DEFAULT_HOOK_PROCESS_TERMINATION_GRACE_MS = 1_000;
const WINDOWS_HOOK_RUNNER = `
const { spawn } = require('node:child_process');

let envelope = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  envelope += chunk;
});
process.stdin.once('error', (error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
process.stdin.once('end', () => {
  let payload;
  try {
    payload = JSON.parse(envelope);
  } catch (error) {
    process.stderr.write(String(error));
    process.exitCode = 1;
    return;
  }

  const child = spawn(payload.command, [], {
    shell: true,
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  let failed = false;
  child.once('error', (error) => {
    failed = true;
    process.stderr.write(String(error));
    process.exitCode = 1;
  });
  child.once('close', (code) => {
    if (!failed) {
      process.exitCode = code ?? 1;
    }
  });
  child.stdin.on('error', (error) => {
    // The command may close stdin without consuming the payload. Its final
    // exit status remains authoritative.
  });
  child.stdin.end(payload.input);
});
`;

function toContainmentError(
  message: string,
  error: unknown,
): HookProcessContainmentError {
  return isHookProcessContainmentError(error)
    ? error
    : new HookProcessContainmentError(message, { cause: error });
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
    const windowsJob = process.platform === 'win32'
      ? await WindowsProcessJob.create()
      : undefined;
    if (context.abortSignal?.aborted) {
      windowsJob?.close();
      return this.createCancelledResult();
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = windowsJob
        ? spawn(process.execPath, ['-e', WINDOWS_HOOK_RUNNER], {
            env,
            cwd: context.projectDir,
            windowsHide: true,
          })
        : spawn(command, [], {
            shell: true,
            env,
            cwd: context.projectDir,
            ...shellProcessSpawnOptions(),
          });
    } catch (error) {
      windowsJob?.close();
      throw windowsJob
        ? new HookProcessContainmentError(
            'Failed to spawn the contained Windows Hook process',
            { cause: error },
          )
        : error;
    }
    child.once('error', () => {
      // Keep spawn failures observed if containment setup rejects before the
      // main lifecycle listeners are installed.
    });

    if (windowsJob) {
      try {
        if (!child.pid) {
          throw new Error('Hook process did not expose a process identifier');
        }
        windowsJob.assign(child.pid);
      } catch (error) {
        try {
          await terminateProcessTree(
            child.pid,
            child,
            this.terminationGraceMs,
          );
        } catch (cleanupError) {
          throw new HookProcessContainmentError(
            'Failed to contain or terminate the Windows Hook process',
            { cause: new AggregateError([error, cleanupError]) },
          );
        } finally {
          windowsJob.close();
        }
        throw new HookProcessContainmentError(
          'Failed to contain the Windows Hook process',
          { cause: error },
        );
      }
    }
    const processInput = windowsJob
      ? JSON.stringify({ command, input: inputJson })
      : inputJson;

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
      let termination:
        | 'abort'
        | 'timeout'
        | 'process-error'
        | undefined;
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
        reason: 'abort' | 'timeout' | 'process-error',
        cause?: unknown,
      ): void => {
        if (settled || termination) {
          return;
        }
        termination = reason;
        cleanup();
        const processCleanup = windowsJob
          ? windowsJob.terminateAndWait()
          : terminateProcessTree(
              child.pid,
              child,
              this.terminationGraceMs,
            );
        void processCleanup.then(
          () => {
            if (reason === 'process-error') {
              rejectOnce(
                windowsJob
                  ? new HookProcessContainmentError(
                      'The contained Windows Hook process failed',
                      { cause },
                    )
                  : cause,
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
          (error) => {
            rejectOnce(
              toContainmentError('Failed to terminate the Hook process tree', error),
            );
          },
        );
      };

      child.on('close', (code) => {
        if (termination) return;
        cleanup();
        const processCleanup = windowsJob
          ? windowsJob.terminateAndWait()
          : terminateProcessTree(
              child.pid,
              child,
              this.terminationGraceMs,
            );
        void processCleanup.then(() => {
          if (termination) return;
          resolveOnce({
            stdout: stdout.getContent(),
            stderr: stderr.getContent(),
            exitCode: code ?? 1,
            timedOut: false,
          });
        }, (error) => {
          rejectOnce(
            toContainmentError('Failed to reap the Hook process tree', error),
          );
        });
      });

      child.on('error', (error) => {
        stop('process-error', error);
      });
      child.stdin.on('error', () => {
        // Fast hooks may close stdin before the write completes. Their exit
        // status remains authoritative.
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
          child.stdin.write(processInput);
          child.stdin.end();
        } catch {
          // Wait for close or timeout; the process exit status is authoritative.
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
