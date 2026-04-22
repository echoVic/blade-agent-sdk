import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { SdkError } from '../errors/SdkError.js';

const RESTRICTED_PATHS = [
  '.git',
  '.claude',
  'node_modules',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.test',
];

class PathSecurityError extends SdkError {
  constructor(message: string, code: string) {
    super(code, message);
  }
}

export function normalizePath(inputPath: string, workspaceRoot: string): string {
  const absolutePath = path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(workspaceRoot, inputPath);

  const normalized = path.normalize(absolutePath);
  const normalizedRoot = path.normalize(workspaceRoot);

  if (!normalized.startsWith(normalizedRoot)) {
    throw new PathSecurityError(
      `Path outside workspace: ${inputPath} (resolved to ${normalized}, workspace: ${normalizedRoot})`,
      'PATH_OUTSIDE_WORKSPACE',
    );
  }

  return normalized;
}

export function checkRestricted(absolutePath: string): void {
  const segments = absolutePath.split(path.sep);

  for (const restricted of RESTRICTED_PATHS) {
    if (segments.includes(restricted)) {
      throw new PathSecurityError(
        `Access denied: "${restricted}" is a protected directory`,
        'RESTRICTED_PATH',
      );
    }
  }
}

function checkTraversal(inputPath: string): void {
  if (inputPath.includes('..')) {
    throw new PathSecurityError(`Path traversal not allowed: ${inputPath}`, 'PATH_TRAVERSAL');
  }
}

export async function validatePath(inputPath: string, workspaceRoot: string): Promise<string> {
  checkTraversal(inputPath);
  const absolutePath = normalizePath(inputPath, workspaceRoot);
  checkRestricted(absolutePath);

  try {
    await fs.access(absolutePath);
  } catch (_error) {
    throw new PathSecurityError(`Path not found: ${inputPath}`, 'PATH_NOT_FOUND');
  }

  return absolutePath;
}

async function resolveSymlink(absolutePath: string, workspaceRoot: string): Promise<string> {
  try {
    const realPath = await fs.realpath(absolutePath);
    const normalizedRoot = path.normalize(workspaceRoot);
    if (!realPath.startsWith(normalizedRoot)) {
      throw new PathSecurityError(
        `Symlink points outside workspace: ${absolutePath} -> ${realPath}`,
        'SYMLINK_OUTSIDE_WORKSPACE',
      );
    }
    return realPath;
  } catch (error) {
    if (error instanceof PathSecurityError) {
      throw error;
    }
    return absolutePath;
  }
}

export function getRelativePath(absolutePath: string, workspaceRoot: string): string {
  return path.relative(workspaceRoot, absolutePath);
}

export function isWithinWorkspace(absolutePath: string, workspaceRoot: string): boolean {
  const normalized = path.normalize(absolutePath);
  const normalizedRoot = path.normalize(workspaceRoot);
  return normalized.startsWith(normalizedRoot);
}

function isRestricted(absolutePath: string): boolean {
  const segments = absolutePath.split(path.sep);
  return RESTRICTED_PATHS.some((restricted) => segments.includes(restricted));
}

export const PathSecurity = {
  normalize: normalizePath,
  checkRestricted,
  checkTraversal,
  validatePath,
  resolveSymlink,
  getRelativePath,
  isWithinWorkspace,
  isRestricted,
};
