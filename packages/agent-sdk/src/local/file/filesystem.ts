import { access, readFile, stat } from 'node:fs/promises';

export interface LocalFileStat {
  size: number;
  isDirectory: boolean;
  mtime: Date;
}

export interface LocalFileSystemPort {
  exists(filePath: string): Promise<boolean>;
  stat(filePath: string): Promise<LocalFileStat | undefined>;
  readTextFile(filePath: string): Promise<string>;
  readBinaryFile(filePath: string): Promise<Uint8Array>;
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
  };
}
