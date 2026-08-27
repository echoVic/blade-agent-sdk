import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { getErrorCode, getErrorMessage } from '../../utils/errorUtils.js';

export interface ResolveFilesystemPathOptions {
  allowMissing?: boolean;
  cwd?: string;
}

export interface FilesystemPathScope {
  readonly filesystemRoots: readonly string[];
  readonly cwd?: string;
}

export class FilesystemPathError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FilesystemPathError';
  }
}

/**
 * Resolves a filesystem path through symlinks and verifies that the resulting
 * target is contained by one of the active RuntimeContext filesystem roots.
 */
export async function resolveAuthorizedFilesystemPath(
  inputPath: string,
  snapshot: FilesystemPathScope | undefined,
  options: ResolveFilesystemPathOptions = {},
): Promise<string> {
  const roots = snapshot?.filesystemRoots ?? [];
  if (roots.length === 0) {
    throw new FilesystemPathError('No filesystem access in current context');
  }

  const cwd = options.cwd ?? snapshot?.cwd;
  if (!isAbsolute(inputPath) && !cwd) {
    throw new FilesystemPathError(
      `Relative filesystem path requires a working directory: ${inputPath}`,
    );
  }

  const absolutePath = resolve(cwd ?? '/', inputPath);
  let canonicalPath: string;
  try {
    canonicalPath = await canonicalizePath(absolutePath, options.allowMissing === true);
  } catch (error) {
    throw new FilesystemPathError(
      `Unable to resolve filesystem path "${inputPath}": ${getErrorMessage(error)}`,
      { cause: error },
    );
  }

  const canonicalRoots = await Promise.all(
    roots.map(async (root) => {
      try {
        return await realpath(resolve(root));
      } catch (error) {
        throw new FilesystemPathError(
          `Unable to resolve filesystem root "${root}": ${getErrorMessage(error)}`,
          { cause: error },
        );
      }
    }),
  );

  if (!canonicalRoots.some((root) => isPathWithinRoot(canonicalPath, root))) {
    throw new FilesystemPathError(`Filesystem path is outside authorized roots: ${inputPath}`);
  }

  return canonicalPath;
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === '' ||
    (!isAbsolute(relativePath) &&
      relativePath !== '..' &&
      !relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  );
}

async function canonicalizePath(absolutePath: string, allowMissing: boolean): Promise<string> {
  try {
    return await realpath(absolutePath);
  } catch (error) {
    if (!allowMissing || getErrorCode(error) !== 'ENOENT') {
      throw error;
    }
    await rejectDanglingSymlink(absolutePath);
  }

  const missingSegments: string[] = [];
  let existingAncestor = absolutePath;

  while (true) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new FilesystemPathError(`No existing ancestor found for path: ${absolutePath}`);
    }
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;

    try {
      const canonicalAncestor = await realpath(existingAncestor);
      return resolve(canonicalAncestor, ...missingSegments);
    } catch (error) {
      if (getErrorCode(error) !== 'ENOENT') {
        throw error;
      }
      await rejectDanglingSymlink(existingAncestor);
    }
  }
}

async function rejectDanglingSymlink(filePath: string): Promise<void> {
  try {
    if ((await lstat(filePath)).isSymbolicLink()) {
      throw new FilesystemPathError(
        `Filesystem path contains an unresolved symbolic link: ${filePath}`,
      );
    }
  } catch (error) {
    if (error instanceof FilesystemPathError) throw error;
    if (getErrorCode(error) !== 'ENOENT') throw error;
  }
}
