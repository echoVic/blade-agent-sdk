import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { ExecutionHostError } from './ExecutionHost.js';

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessOptions {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
  readonly stdin?: string | Uint8Array;
  readonly environment?: Readonly<Record<string, string>>;
}

export function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: { ...process.env, ...options.environment },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    const stop = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(
      () =>
        stop(
          new ExecutionHostError(
            'EXECUTION_TIMEOUT',
            `Container runtime exceeded ${options.timeoutMs}ms`,
          ),
        ),
      options.timeoutMs,
    );
    timer.unref();
    const abort = () =>
      stop(
        new ExecutionHostError('EXECUTION_RUNTIME_ERROR', 'Container runtime was aborted', {
          cause: options.signal?.reason,
        }),
      );
    options.signal?.addEventListener('abort', abort, { once: true });

    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > options.maxBytes) {
        stop(new ExecutionHostError('EXECUTION_OUTPUT_LIMIT', 'Execution output limit exceeded'));
      } else {
        target.push(chunk);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.stdin.on('error', () => undefined);
    child.once('error', (cause) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new ExecutionHostError('EXECUTION_HOST_UNAVAILABLE', `Could not start ${command}`, {
          cause,
        }),
      );
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failure) reject(failure);
      else {
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      }
    });
    child.stdin.end(options.stdin);
  });
}

export async function runCheckedProcess(
  command: string,
  args: readonly string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const result = await runProcess(command, args, options);
  if (result.exitCode !== 0) {
    throw new ExecutionHostError(
      'EXECUTION_RUNTIME_ERROR',
      result.stderr || `${command} exited with code ${result.exitCode}`,
    );
  }
  return result;
}

export function runProcessToFile(
  command: string,
  args: readonly string[],
  outputPath: string,
  options: Omit<ProcessOptions, 'stdin'>,
): Promise<ProcessResult> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: { ...process.env, ...options.environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = createWriteStream(outputPath, { mode: 0o600 });
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    const stop = (error: Error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(
      () =>
        stop(
          new ExecutionHostError(
            'EXECUTION_TIMEOUT',
            `Container runtime exceeded ${options.timeoutMs}ms`,
          ),
        ),
      options.timeoutMs,
    );
    timer.unref();
    const abort = () =>
      stop(
        new ExecutionHostError('EXECUTION_RUNTIME_ERROR', 'Container runtime was aborted', {
          cause: options.signal?.reason,
        }),
      );
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > options.maxBytes) {
        stop(new ExecutionHostError('EXECUTION_OUTPUT_LIMIT', 'Execution output limit exceeded'));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      stderr.push(chunk);
      if (bytes > options.maxBytes) {
        stop(new ExecutionHostError('EXECUTION_OUTPUT_LIMIT', 'Execution output limit exceeded'));
      }
    });
    child.stdout.pipe(output);
    output.once('error', stop);
    child.once('error', (cause) => {
      if (settled) return;
      settled = true;
      cleanup();
      output.destroy();
      reject(
        new ExecutionHostError('EXECUTION_HOST_UNAVAILABLE', `Could not start ${command}`, {
          cause,
        }),
      );
    });
    child.once('close', async (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        await finished(output);
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
      }
      if (failure) {
        reject(failure);
        return;
      }
      resolve({
        exitCode: code ?? 1,
        stdout: '',
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}
