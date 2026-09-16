import { spawn } from 'node:child_process';
import { accessSync, constants, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Entry } from 'fast-glob';
import fg from 'fast-glob';
import { hasFilesystemCapability } from '../../../runtime/index.js';
import { getErrorMessage } from '../../../utils/errorUtils.js';
import { DEFAULT_EXCLUDE_DIRS, FileFilter } from '../../../utils/filePatterns.js';
import type { ExecutionContext } from '../../types/execution.js';
import { ToolErrorType, type ToolValidationError } from '../../types/result.js';
import { resolveAuthorizedFilesystemPath } from '../../validation/filesystemPath.js';

const require = createRequire(import.meta.url);

export interface SearchMatch {
  path: string;
  relative_path: string;
  is_directory: boolean;
  size?: number;
  modified?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function validateSearchPath(
  params: { path?: string },
  context: ExecutionContext,
): Promise<ToolValidationError | undefined> {
  if (!hasFilesystemCapability(context.contextSnapshot)) {
    return {
      message: 'No filesystem access in current context',
      model: 'No filesystem access in the current runtime context.',
      errorType: ToolErrorType.PERMISSION_DENIED,
    };
  }
  const root = params.path ?? context.contextSnapshot?.cwd;
  if (!root) {
    return {
      message: 'No search path available',
      model: 'No search path provided and no filesystem working directory is available.',
      errorType: ToolErrorType.VALIDATION_ERROR,
    };
  }
  try {
    params.path = await resolveAuthorizedFilesystemPath(root, context.contextSnapshot, {
      cwd: context.contextSnapshot?.cwd,
    });
    return undefined;
  } catch (error) {
    const message = getErrorMessage(error);
    return { message, model: message, errorType: ToolErrorType.PERMISSION_DENIED };
  }
}

export async function requireSearchDirectory(path: string): Promise<string> {
  const absolutePath = resolve(path);
  let stats: Stats;
  try {
    stats = await stat(absolutePath);
  } catch (error) {
    throw Object.assign(new Error(`Search path does not exist: ${absolutePath}`), {
      code: 'SEARCH_PATH_MISSING',
      cause: error,
    });
  }
  if (!stats.isDirectory()) {
    throw Object.assign(new Error(`Search path must be a directory: ${absolutePath}`), {
      code: 'SEARCH_PATH_NOT_DIRECTORY',
    });
  }
  return absolutePath;
}

export async function runGlob(
  root: string,
  pattern: string,
  options: {
    maxResults: number;
    includeDirectories: boolean;
    caseSensitive: boolean;
    signal: AbortSignal;
  },
): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
  options.signal.throwIfAborted();
  const fileFilter = await FileFilter.create({
    cwd: root,
    useGitignore: true,
    useDefaults: true,
    gitignoreScanMode: 'recursive',
    customScanIgnore: [],
    cacheTTL: 30_000,
  });
  const entries = await fg(pattern, {
    cwd: root,
    dot: true,
    followSymbolicLinks: false,
    unique: true,
    caseSensitiveMatch: options.caseSensitive,
    objectMode: true,
    stats: true,
    onlyFiles: !options.includeDirectories,
    ignore: fileFilter.getIgnorePatterns(),
  });
  options.signal.throwIfAborted();
  const matches = entries
    .filter((entry) => !fileFilter.shouldIgnore(entry.path))
    .filter((entry) => !entry.dirent.isDirectory() || !fileFilter.shouldIgnoreDirectory(entry.path))
    .map((entry) => toSearchMatch(root, entry))
    .sort(compareMatches);
  return {
    matches: matches.slice(0, options.maxResults),
    truncated: matches.length > options.maxResults,
  };
}

export function buildRipgrepArgs(options: {
  pattern: string;
  path: string;
  glob?: string;
  type?: string;
  outputMode: 'content' | 'files_with_matches' | 'count';
  caseInsensitive: boolean;
  lineNumbers: boolean;
  contextBefore?: number;
  contextAfter?: number;
  context?: number;
  multiline: boolean;
}): string[] {
  const args = ['--color', 'never', '--path-separator', '/', '--with-filename'];
  if (options.caseInsensitive) args.push('-i');
  if (options.multiline) args.push('-U', '--multiline-dotall');
  if (options.outputMode === 'files_with_matches') args.push('-l');
  if (options.outputMode === 'count') args.push('-c');
  if (options.outputMode === 'content' && options.lineNumbers) args.push('-n');
  if (options.outputMode === 'content') {
    if (options.context !== undefined) args.push('-C', String(options.context));
    else {
      if (options.contextBefore !== undefined) args.push('-B', String(options.contextBefore));
      if (options.contextAfter !== undefined) args.push('-A', String(options.contextAfter));
    }
  }
  if (options.type) args.push('--type', options.type);
  for (const directory of DEFAULT_EXCLUDE_DIRS) args.push('--glob', `!**/${directory}/**`);
  if (options.glob) args.push('--glob', options.glob);
  args.push('--', options.pattern, options.path);
  return args;
}

export async function runRipgrep(args: string[], signal: AbortSignal): Promise<CommandResult> {
  return runCommand(resolveRipgrep(), args, signal);
}

function toSearchMatch(root: string, entry: Entry): SearchMatch {
  const relativePath = entry.path.replaceAll('\\', '/');
  const stats = entry.stats;
  const isDirectory = entry.dirent.isDirectory();
  return {
    path: join(root, relativePath),
    relative_path: relativePath,
    is_directory: isDirectory,
    ...(!isDirectory && stats ? { size: stats.size } : {}),
    ...(stats ? { modified: stats.mtime.toISOString() } : {}),
  };
}

function compareMatches(left: SearchMatch, right: SearchMatch): number {
  if (left.is_directory !== right.is_directory) return left.is_directory ? 1 : -1;
  if (left.modified && right.modified) {
    const modifiedOrder = Date.parse(right.modified) - Date.parse(left.modified);
    if (modifiedOrder !== 0) return modifiedOrder;
  }
  return left.relative_path.localeCompare(right.relative_path);
}

function resolveRipgrep(): string {
  const executable = process.platform === 'win32' ? 'rg.exe' : 'rg';
  for (const directory of process.env.PATH?.split(delimiter) ?? []) {
    const candidate = join(directory, executable);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }

  const platform = `${process.platform}-${process.arch}`;
  const vendor: Record<string, string> = {
    'darwin-arm64': 'darwin-arm64/rg',
    'darwin-x64': 'darwin-x64/rg',
    'linux-arm64': 'linux-arm64/rg',
    'linux-x64': 'linux-x64/rg',
    'win32-x64': 'win32-x64/rg.exe',
  };
  const vendorPath = vendor[platform];
  if (vendorPath) {
    const candidate = fileURLToPath(
      new URL(`../../../../vendor/ripgrep/${vendorPath}`, import.meta.url),
    );
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }

  try {
    const vscodeRipgrep = require('@vscode/ripgrep') as { rgPath?: string };
    if (vscodeRipgrep.rgPath) return vscodeRipgrep.rgPath;
  } catch {}
  throw new Error('ripgrep is not available');
}

function runCommand(command: string, args: string[], signal: AbortSignal): Promise<CommandResult> {
  signal.throwIfAborted();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      resolvePromise({
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
        exitCode: code ?? 1,
      });
    });
    signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
  });
}
