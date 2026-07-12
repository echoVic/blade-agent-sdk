import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';

export interface LocalFileSystemPort {
  exists(filePath: string): Promise<boolean>;
  stat(filePath: string): Promise<LocalFileStat | undefined>;
  readTextFile(filePath: string): Promise<string>;
  readBinaryFile(filePath: string): Promise<Uint8Array>;
  writeTextFile(filePath: string, content: string): Promise<void>;
  mkdir(dirPath: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
}

export interface LocalFileStat {
  size: number;
  isDirectory: boolean;
  mtime: Date;
}

export function createNodeLocalFileSystem(): LocalFileSystemPort {
  return {
    async exists(filePath) {
      try {
        await access(filePath);
        return true;
      } catch {
        return false;
      }
    },
    async stat(filePath) {
      try {
        const result = await stat(filePath);
        return {
          size: result.size,
          isDirectory: result.isDirectory(),
          mtime: result.mtime,
        };
      } catch {
        return undefined;
      }
    },
    readTextFile(filePath) {
      return readFile(filePath, 'utf8');
    },
    readBinaryFile(filePath) {
      return readFile(filePath);
    },
    writeTextFile(filePath, content) {
      return writeFile(filePath, content, 'utf8');
    },
    async mkdir(dirPath, options) {
      await mkdir(dirPath, {
        recursive: options?.recursive ?? false,
        mode: options?.mode ?? 0o755,
      });
    },
  };
}
