export function isAcpMode(): boolean {
  return false;
}

export interface TerminalExecuteOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  onOutput?: (output: string) => void;
}

export interface TerminalExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
  error?: string;
}

export interface TerminalService {
  execute(command: string, options?: TerminalExecuteOptions): Promise<TerminalExecuteResult>;
}

export function getTerminalService(): TerminalService {
  throw new Error('ACP mode is not available');
}
