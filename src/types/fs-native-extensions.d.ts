declare module 'fs-native-extensions' {
  export interface FileLockOptions {
    shared?: boolean;
  }

  export function tryLock(fd: number, options?: FileLockOptions): boolean;
  export function tryLock(fd: number, offset: number, options?: FileLockOptions): boolean;
  export function tryLock(
    fd: number,
    offset?: number,
    length?: number,
    options?: FileLockOptions,
  ): boolean;

  export function unlock(fd: number, offset?: number, length?: number): void;
}
