import { execSync } from 'node:child_process';
import * as path from 'node:path';
import type { SessionId } from '../../types/branded.js';

/**
 * 路径转义工具 - 将项目路径转为目录名
 */

/**
 * 转义项目路径为目录名
 * 规则：将 / 和 \ 替换为 -，将 : 替换为 _ (Windows 驱动器符号)
 *
 * @example
 * escapeProjectPath('/Users/john/projects/my-app')
 * // 返回: '-Users-john-projects-my-app'
 * escapeProjectPath('C:\\Users\\HP\\project')
 * // 返回: 'C_-Users-HP-project'
 */
function escapeProjectPath(absPath: string): string {
  const normalized = path.resolve(absPath);
  return normalized.replace(/[/\\]/g, '-').replace(/:/g, '_');
}

/**
 * 反转义目录名为项目路径
 *
 * @example
 * unescapeProjectPath('-Users-john-projects-my-app')
 * // 返回: '/Users/john/projects/my-app'
 * unescapeProjectPath('C_-Users-HP-project')
 * // 返回: 'C:/Users/HP/project' (使用正斜杠，Node.js 在 Windows 上也支持)
 */
export function unescapeProjectPath(escapedPath: string): string {
  let result = escapedPath.replace(/_/g, ':');
  if (result.startsWith('-')) {
    result = '/' + result.slice(1);
  }
  return result.replace(/-/g, '/');
}

/**
 * 获取项目的存储路径
 *
 * @param storageRoot SDK 数据存储根目录（由调用方提供，如 ~/.blade）
 * @param projectPath 项目绝对路径
 * @returns {storageRoot}/projects/{escaped-path}/
 */
export function getProjectStoragePath(storageRoot: string, projectPath: string): string {
  const escaped = escapeProjectPath(projectPath);
  return path.join(storageRoot, 'projects', escaped);
}

/**
 * 获取全局会话存储目录
 *
 * @param storageRoot SDK 数据存储根目录
 * @returns {storageRoot}/sessions/
 */
export function getSessionStoragePath(storageRoot: string): string {
  return path.join(storageRoot, 'sessions');
}

export function normalizeSessionStorageRoot(storageRoot: string): string {
  return path.basename(storageRoot) === 'sessions'
    ? storageRoot
    : getSessionStoragePath(storageRoot);
}

/**
 * 获取项目的会话文件路径
 *
 * @param storageRoot SDK 数据存储根目录
 * @param projectPath 项目绝对路径
 * @param sessionId 会话 ID
 * @returns {storageRoot}/projects/{escaped-path}/{sessionId}.jsonl
 */
export function getSessionFilePath(storageRoot: string, projectPath: string, sessionId: SessionId): string {
  return path.join(getProjectStoragePath(storageRoot, projectPath), `${sessionId}.jsonl`);
}

/**
 * 获取全局会话文件路径
 *
 * @param storageRoot 会话存储根目录
 * @param sessionId 会话 ID
 */
export function getSessionFilePathFromStorageRoot(
  storageRoot: string,
  sessionId: SessionId,
): string {
  return path.join(normalizeSessionStorageRoot(storageRoot), `${sessionId}.jsonl`);
}

/**
 * 检测当前项目的 Git 分支
 * @param projectPath 项目路径
 * @returns Git 分支名称，如果不是 Git 仓库则返回 undefined
 */
export function detectGitBranch(projectPath?: string): string | undefined {
  if (!projectPath) {
    return undefined;
  }
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 获取所有项目目录列表
 *
 * @param storageRoot SDK 数据存储根目录
 * @returns 项目目录名称数组
 */
export async function listProjectDirectories(storageRoot: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  try {
    const projectsDir = path.join(storageRoot, 'projects');
    const entries = await readdir(projectsDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
