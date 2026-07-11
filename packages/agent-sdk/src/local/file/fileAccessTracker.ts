import { stat } from 'node:fs/promises';

export interface FileAccessRecord {
  filePath: string;
  accessTime: number;
  mtime: number;
  sessionId: string;
  lastOperation: 'read' | 'edit' | 'write';
}

export interface FileAccessLogger {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

const NOOP_LOGGER: FileAccessLogger = {
  debug() {},
  warn() {},
};

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class FileAccessTracker {
  private static instance: FileAccessTracker | null = null;
  private logger: FileAccessLogger = NOOP_LOGGER;
  private readonly accessedFiles = new Map<string, FileAccessRecord>();

  private constructor() {}

  static getInstance(logger?: FileAccessLogger): FileAccessTracker {
    if (!FileAccessTracker.instance) {
      FileAccessTracker.instance = new FileAccessTracker();
    }
    if (logger) {
      FileAccessTracker.instance.setLogger(logger);
    }
    return FileAccessTracker.instance;
  }

  setLogger(logger: FileAccessLogger): void {
    this.logger = logger;
  }

  async recordFileRead(filePath: string, sessionId: string): Promise<void> {
    try {
      const stats = await stat(filePath);
      this.accessedFiles.set(filePath, {
        filePath,
        accessTime: Date.now(),
        mtime: stats.mtimeMs,
        sessionId,
        lastOperation: 'read',
      });
      this.logger.debug(`Recorded file read: ${filePath}`);
    } catch (error) {
      this.logger.warn(`Failed to record file read: ${filePath}`, error);
    }
  }

  async recordFileEdit(
    filePath: string,
    sessionId: string,
    operation: 'edit' | 'write' = 'edit',
  ): Promise<void> {
    try {
      const stats = await stat(filePath);
      this.accessedFiles.set(filePath, {
        filePath,
        accessTime: Date.now(),
        mtime: stats.mtimeMs,
        sessionId,
        lastOperation: operation,
      });
      this.logger.debug(`Recorded file ${operation}: ${filePath}`);
    } catch (error) {
      this.logger.warn(`Failed to record file ${operation}: ${filePath}`, error);
    }
  }

  hasFileBeenRead(filePath: string, sessionId?: string): boolean {
    const record = this.accessedFiles.get(filePath);
    return record !== undefined && (sessionId === undefined || record.sessionId === sessionId);
  }

  async checkFileModification(
    filePath: string,
  ): Promise<{ modified: boolean; message?: string }> {
    const record = this.accessedFiles.get(filePath);
    if (!record) {
      return { modified: false, message: '文件未被跟踪' };
    }

    try {
      const stats = await stat(filePath);
      if (Math.abs(stats.mtimeMs - record.mtime) > 1) {
        return {
          modified: true,
          message: `文件在访问后被修改（访问时间: ${new Date(record.accessTime).toISOString()}, 当前修改时间: ${stats.mtime.toISOString()}）`,
        };
      }
      return { modified: false };
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return { modified: true, message: '文件已被删除' };
      }
      return { modified: false, message: `无法检查文件状态: ${getErrorMessage(error)}` };
    }
  }

  async checkExternalModification(
    filePath: string,
  ): Promise<{ isExternal: boolean; message?: string }> {
    const record = this.accessedFiles.get(filePath);
    if (!record) {
      return { isExternal: false, message: '文件未被跟踪' };
    }

    try {
      const stats = await stat(filePath);
      if (stats.mtimeMs - record.mtime > 2000) {
        return {
          isExternal: true,
          message: `文件在 ${new Date(record.accessTime).toISOString()} (${record.lastOperation}) 之后被外部程序修改（当前修改时间: ${stats.mtime.toISOString()}）`,
        };
      }
      return { isExternal: false };
    } catch (error) {
      if (getErrorCode(error) === 'ENOENT') {
        return { isExternal: true, message: '文件已被删除' };
      }
      this.logger.warn(`Failed to check external modification: ${filePath}`, error);
      return { isExternal: false, message: `无法检查文件状态: ${getErrorMessage(error)}` };
    }
  }

  getFileRecord(filePath: string): FileAccessRecord | undefined {
    return this.accessedFiles.get(filePath);
  }

  clearFileRecord(filePath: string): void {
    this.accessedFiles.delete(filePath);
  }

  clearAll(): void {
    this.accessedFiles.clear();
  }

  clearSession(sessionId: string): void {
    for (const [filePath, record] of this.accessedFiles) {
      if (record.sessionId === sessionId) {
        this.accessedFiles.delete(filePath);
      }
    }
  }

  getTrackedFiles(): string[] {
    return [...this.accessedFiles.keys()];
  }

  getTrackedFileCount(): number {
    return this.accessedFiles.size;
  }

  static resetInstance(): void {
    FileAccessTracker.instance = null;
  }
}
