/**
 * 临时流式调试日志
 *
 * 专门用于调试流式响应问题，写入独立文件便于分析
 * 调试完成后删除此文件
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { JsonObject } from '../types/common.js';

let logFile: string | undefined;
let initialized = false;

/**
 * 配置调试日志文件路径
 * 不调用此方法时，streamDebug 为 no-op
 */
export function configureStreamDebug(filePath: string): void {
  logFile = filePath;
  initialized = false; // 重置，下次写入时重新初始化
}

function ensureLogFile(): void {
  if (initialized || !logFile) return;
  const logDir = path.dirname(logFile);
  mkdirSync(logDir, { recursive: true, mode: 0o755 });
  writeFileSync(
    logFile,
    `=== Stream Debug Log Started: ${new Date().toISOString()} ===\n`
  );
  initialized = true;
}

export function streamDebug(
  source: string,
  message: string,
  data?: JsonObject
): void {
  if (!logFile) return;
  ensureLogFile();
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
  const line = `[${timestamp}] [${source}] ${message}${dataStr}\n`;
  appendFileSync(logFile, line);
}
