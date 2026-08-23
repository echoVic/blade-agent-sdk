import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { DurableExecutionFence } from '../../../session/events/DurableExecutionLeaseStore.js';
import type { SessionId } from '../../../types/branded.js';
import {
  isProcessTreeAlive,
  shellProcessSpawnOptions,
  signalProcessTree,
  waitForProcessTreeExit,
} from './processTree.js';

type BackgroundShellStatus = 'running' | 'exited' | 'killed' | 'error';
const DEFAULT_TERMINATION_GRACE_MS = 2_000;

interface StartOptions {
  command: string;
  sessionId: SessionId;
  cwd: string;
  env?: Record<string, string | undefined>;
  executionFence?: DurableExecutionFence;
}

interface BackgroundShellProcess {
  id: string;
  command: string;
  sessionId: SessionId;
  executionFence?: DurableExecutionFence;
  cwd?: string;
  env?: Record<string, string | undefined>;
  process?: ChildProcess;
  pid?: number;
  status: BackgroundShellStatus;
  exitCode?: number | null;
  signal?: string | null;
  startTime: number;
  endTime?: number;
  errorMessage?: string;
  pendingStdout: string;
  pendingStderr: string;
}

export interface ShellOutputSnapshot {
  id: string;
  command: string;
  status: BackgroundShellStatus;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  signal?: string | null;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  errorMessage?: string;
}

export interface KillResult {
  success: boolean;
  alreadyExited: boolean;
  status: BackgroundShellStatus;
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
}

export class BackgroundShellManager {
  private static instance: BackgroundShellManager | null = null;
  private processes = new Map<string, BackgroundShellProcess>();
  private sealedSessionIds = new Set<SessionId>();
  private revokedExecutionFences = new Set<string>();

  static getInstance(): BackgroundShellManager {
    if (!BackgroundShellManager.instance) {
      BackgroundShellManager.instance = new BackgroundShellManager();
    }
    return BackgroundShellManager.instance;
  }

  startBackgroundProcess(options: StartOptions): BackgroundShellProcess {
    if (
      this.sealedSessionIds.has(options.sessionId) ||
      (
        options.executionFence &&
        this.revokedExecutionFences.has(
          this.executionFenceKey(options.sessionId, options.executionFence),
        )
      )
    ) {
      throw new Error(`Background shell admission is closed for Session ${options.sessionId}`);
    }

    const shellId = `bash_${randomUUID()}`;
    const mergedEnv: Record<string, string> = {};

    for (const [key, value] of Object.entries({
      ...process.env,
      ...options.env,
      BLADE_CLI: '1',
    })) {
      if (value !== undefined) {
        mergedEnv[key] = value;
      }
    }

    const child = spawn('bash', ['-c', options.command], {
      cwd: options.cwd,
      env: mergedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...shellProcessSpawnOptions(),
    });

    const processInfo: BackgroundShellProcess = {
      id: shellId,
      command: options.command,
      sessionId: options.sessionId,
      executionFence: options.executionFence,
      cwd: options.cwd,
      env: options.env,
      process: child,
      pid: child.pid,
      status: 'running',
      startTime: Date.now(),
      pendingStdout: '',
      pendingStderr: '',
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk: Buffer | string) => {
      processInfo.pendingStdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      processInfo.pendingStderr += chunk.toString();
    });

    child.on('close', (code, signal) => {
      processInfo.exitCode = code;
      processInfo.signal = signal;
      processInfo.process = undefined;
      this.refreshProcessStatus(processInfo);
    });

    child.on('error', (error) => {
      processInfo.status = 'error';
      processInfo.errorMessage = error.message;
      processInfo.endTime = Date.now();
      processInfo.process = undefined;
      processInfo.pendingStderr += `\n[error] ${error.message}`;
    });

    this.processes.set(shellId, processInfo);
    return processInfo;
  }

  consumeOutput(shellId: string): ShellOutputSnapshot | undefined {
    const processInfo = this.processes.get(shellId);
    if (!processInfo) {
      return undefined;
    }
    this.refreshProcessStatus(processInfo);

    const snapshot: ShellOutputSnapshot = {
      id: processInfo.id,
      command: processInfo.command,
      status: processInfo.status,
      stdout: processInfo.pendingStdout,
      stderr: processInfo.pendingStderr,
      exitCode: processInfo.exitCode,
      signal: processInfo.signal,
      pid: processInfo.pid,
      startedAt: processInfo.startTime,
      endedAt: processInfo.endTime,
      errorMessage: processInfo.errorMessage,
    };

    processInfo.pendingStdout = '';
    processInfo.pendingStderr = '';

    return snapshot;
  }

  getProcess(shellId: string): BackgroundShellProcess | undefined {
    const processInfo = this.processes.get(shellId);
    if (processInfo) {
      this.refreshProcessStatus(processInfo);
    }
    return processInfo;
  }

  getActiveProcessIds(
    sessionId: SessionId,
    executionFence?: DurableExecutionFence,
  ): readonly string[] {
    return [...this.processes.values()]
      .filter(
        (processInfo) =>
          processInfo.sessionId === sessionId &&
          isProcessTreeAlive(processInfo.pid, processInfo.process) &&
          (
            executionFence === undefined ||
            processInfo.executionFence === undefined ||
            this.sameExecutionFence(processInfo.executionFence, executionFence)
          ),
      )
      .map((processInfo) => processInfo.id);
  }

  sealSessionForHandoff(sessionId: SessionId): void {
    this.sealedSessionIds.add(sessionId);
  }

  openSession(sessionId: SessionId): void {
    this.sealedSessionIds.delete(sessionId);
  }

  sealExecutionFence(sessionId: SessionId, fence: DurableExecutionFence): void {
    this.revokedExecutionFences.add(this.executionFenceKey(sessionId, fence));
  }

  killSession(sessionId: SessionId): readonly string[] {
    this.sealSessionForHandoff(sessionId);
    const shellIds = this.getActiveProcessIds(sessionId);
    for (const shellId of shellIds) {
      this.kill(shellId);
    }
    return shellIds;
  }

  async terminateSession(
    sessionId: SessionId,
    gracePeriodMs = DEFAULT_TERMINATION_GRACE_MS,
  ): Promise<readonly string[]> {
    if (!Number.isSafeInteger(gracePeriodMs) || gracePeriodMs < 0) {
      throw new Error('Background shell termination grace period must be non-negative');
    }
    const shellIds = this.killSession(sessionId);
    await Promise.all(shellIds.map((shellId) => this.waitForExit(shellId, gracePeriodMs)));
    return shellIds;
  }

  killExecutionFence(
    sessionId: SessionId,
    fence: DurableExecutionFence,
  ): readonly string[] {
    this.sealExecutionFence(sessionId, fence);
    const shellIds = this.getActiveProcessIds(sessionId, fence);
    for (const shellId of shellIds) {
      this.kill(shellId);
    }
    return shellIds;
  }

  async terminateExecutionFence(
    sessionId: SessionId,
    fence: DurableExecutionFence,
    gracePeriodMs = DEFAULT_TERMINATION_GRACE_MS,
  ): Promise<readonly string[]> {
    if (!Number.isSafeInteger(gracePeriodMs) || gracePeriodMs < 0) {
      throw new Error('Background shell termination grace period must be non-negative');
    }
    const shellIds = this.killExecutionFence(sessionId, fence);
    await Promise.all(shellIds.map((shellId) => this.waitForExit(shellId, gracePeriodMs)));
    return shellIds;
  }

  kill(shellId: string): KillResult | undefined {
    const processInfo = this.processes.get(shellId);
    if (!processInfo) {
      return undefined;
    }

    if (!isProcessTreeAlive(processInfo.pid, processInfo.process)) {
      return {
        success: false,
        alreadyExited: true,
        status: processInfo.status,
        pid: processInfo.pid,
        exitCode: processInfo.exitCode,
        signal: processInfo.signal,
      };
    }

    const killed = signalProcessTree(
      processInfo.pid,
      'SIGTERM',
      processInfo.process,
    );
    if (!killed) {
      return {
        success: false,
        alreadyExited: false,
        status: processInfo.status,
        pid: processInfo.pid,
        exitCode: processInfo.exitCode,
        signal: processInfo.signal,
      };
    }

    processInfo.status = 'killed';
    processInfo.endTime = Date.now();

    return {
      success: true,
      alreadyExited: false,
      status: processInfo.status,
      pid: processInfo.pid,
      exitCode: processInfo.exitCode,
      signal: processInfo.signal,
    };
  }

  private async waitForExit(shellId: string, gracePeriodMs: number): Promise<void> {
    const processInfo = this.processes.get(shellId);
    if (
      !processInfo ||
      await waitForProcessTreeExit(
        processInfo.pid,
        processInfo.process,
        gracePeriodMs,
      )
    ) {
      return;
    }

    signalProcessTree(processInfo.pid, 'SIGKILL', processInfo.process);
    if (
      !(await waitForProcessTreeExit(
        processInfo.pid,
        processInfo.process,
        gracePeriodMs,
      ))
    ) {
      throw new Error(`Background shell ${shellId} did not terminate`);
    }
  }

  private executionFenceKey(
    sessionId: SessionId,
    fence: DurableExecutionFence,
  ): string {
    return `${sessionId}\0${fence.leaseId}\0${fence.fencingToken}`;
  }

  private sameExecutionFence(
    left: DurableExecutionFence | undefined,
    right: DurableExecutionFence,
  ): boolean {
    return (
      left?.leaseId === right.leaseId &&
      left.fencingToken === right.fencingToken
    );
  }

  private refreshProcessStatus(processInfo: BackgroundShellProcess): void {
    if (
      processInfo.status === 'running' &&
      !isProcessTreeAlive(processInfo.pid, processInfo.process)
    ) {
      processInfo.status = 'exited';
      processInfo.endTime = Date.now();
    }
  }

  /**
   * 终止所有后台进程
   * 在应用退出时调用
   */
  killAll(): void {
    for (const [_shellId, processInfo] of this.processes) {
      if (isProcessTreeAlive(processInfo.pid, processInfo.process)) {
        try {
          signalProcessTree(
            processInfo.pid,
            'SIGTERM',
            processInfo.process,
          );
          processInfo.status = 'killed';
          processInfo.endTime = Date.now();
          processInfo.process = undefined;
        } catch {
          // 忽略终止失败（进程可能已退出）
        }
      }
    }
    this.processes.clear();
    this.sealedSessionIds.clear();
    this.revokedExecutionFences.clear();
  }
}
