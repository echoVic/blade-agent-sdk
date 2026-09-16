import { spawn } from 'node:child_process';
import { getErrorMessage } from '../../../utils/errorUtils.js';
import { toJsonValue } from '../../../utils/jsonValue.js';
import type { BashForegroundMetadata } from '../../types/metadata.js';
import { ToolErrorType, type ToolResult } from '../../types/result.js';
import { buildShellEnvironment } from './environment.js';
import { OutputTruncator } from './OutputTruncator.js';
import { shellProcessSpawnOptions, terminateProcessTree } from './processTree.js';

export function executeForegroundShell(options: {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  runtimeEnvironment?: Readonly<Record<string, string>>;
  timeout: number;
  signal: AbortSignal;
}): Promise<ToolResult> {
  const { command, cwd, env, runtimeEnvironment, timeout, signal } = options;
  signal.throwIfAborted();
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let termination: Promise<void> | undefined;
    const child = spawn('bash', ['-c', command], {
      cwd,
      env: buildShellEnvironment(runtimeEnvironment, env),
      stdio: ['pipe', 'pipe', 'pipe'],
      ...shellProcessSpawnOptions(),
    });
    const terminate = (): Promise<void> => {
      termination ??= terminateProcessTree(child.pid, child, 1_000).catch((error) => {
        stderr += `\nFailed to terminate command process tree: ${getErrorMessage(error)}`;
      });
      return termination;
    };
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        timedOut = true;
        void terminate();
      }
    }, timeout);
    const abort = () => {
      clearTimeout(timer);
      void terminate();
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };

    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    child.once('close', async (code, processSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      await termination;
      resolve(
        foregroundResult({
          command,
          stdout,
          stderr,
          code,
          processSignal,
          duration: Date.now() - started,
          timeout,
          timedOut,
          aborted: signal.aborted,
        }),
      );
    });
    child.once('error', async (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      await termination;
      resolve({
        status: 'error',
        model: `Command execution failed: ${error.message}`,
        error: { type: ToolErrorType.EXECUTION_ERROR, message: error.message, details: error },
      });
    });
  });
}

function foregroundResult(options: {
  command: string;
  stdout: string;
  stderr: string;
  code: number | null;
  processSignal: NodeJS.Signals | null;
  duration: number;
  timeout: number;
  timedOut: boolean;
  aborted: boolean;
}): ToolResult {
  if (options.timedOut) {
    return {
      status: 'error',
      model: `Command execution timed out (${options.timeout}ms)`,
      error: { type: ToolErrorType.TIMEOUT_ERROR, message: '命令执行超时' },
      metadata: { ...options, execution_time: options.duration },
    };
  }
  if (options.aborted) {
    return {
      status: 'error',
      model: 'Command execution aborted by user',
      error: { type: ToolErrorType.EXECUTION_ERROR, message: '操作被中止' },
      metadata: { ...options, execution_time: options.duration },
    };
  }

  const preview =
    options.command.length > 30 ? `${options.command.slice(0, 30)}...` : options.command;
  const metadata: BashForegroundMetadata = {
    command: options.command,
    execution_time: options.duration,
    exit_code: options.code,
    signal: options.processSignal,
    stdout_length: options.stdout.length,
    stderr_length: options.stderr.length,
    has_stderr: options.stderr.length > 0,
    summary:
      options.code === 0
        ? `执行命令成功 (${options.duration}ms): ${preview}`
        : `执行命令完成 (退出码 ${options.code}, ${options.duration}ms): ${preview}`,
  };
  const output = OutputTruncator.truncateForLLM(
    options.stdout.trim(),
    options.stderr.trim(),
    options.command,
  );
  return {
    status: 'success',
    model: toJsonValue({
      stdout: output.stdout,
      stderr: output.stderr,
      execution_time: options.duration,
      exit_code: options.code,
      signal: options.processSignal,
      ...(output.truncationInfo ? { truncation_info: output.truncationInfo } : {}),
    }),
    metadata,
  };
}
