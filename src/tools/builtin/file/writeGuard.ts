/**
 * Write guard — edit/write 工具共享的写入前校验协议。
 *
 * 统一处理：
 * 1. Read-before-write 检查（必须先 Read 才能写）
 * 2. 外部修改检查（自上次 Read 后文件被外部修改则拒绝）
 * 3. 快照创建（用于撤销/对比，失败不阻断写入）
 * 4. 写入后记录文件访问
 */

import type { MessageId, SessionId } from '../../../types/branded.js';
import { ToolErrorType } from '../../types/ToolResult.js';
import type { ToolResult } from '../../types/ToolResult.js';
import { FileAccessTracker } from './FileAccessTracker.js';
import { SnapshotManager } from './SnapshotManager.js';

export type WriteOperation = 'edit' | 'write';

export interface WriteGuardParams {
  filePath: string;
  sessionId?: SessionId;
  messageId?: MessageId;
  operation: WriteOperation;
  /**
   * 目标文件是否已存在。write 工具新建文件时为 false，此时跳过 read-before-write
   * 与外部修改检查（仅对已存在文件强制）。edit 工具始终为 true。
   */
  fileExists: boolean;
}

export interface WriteGuardResult {
  /** 非 null 表示校验未通过，应直接返回该 ToolResult */
  blocked: ToolResult | null;
  /** 是否成功创建了快照 */
  snapshotCreated: boolean;
}

const NOT_READ_MESSAGES: Record<WriteOperation, string> = {
  edit: 'You must use your Read tool at least once in the conversation before editing. This tool will error if you attempt to edit without reading the file.',
  write: 'If this is an existing file, you MUST use the Read tool first to read the file\'s contents. This tool will fail if you did not read the file first.',
};

const NOT_READ_ERROR_MESSAGES: Record<WriteOperation, string> = {
  edit: 'File not read before edit',
  write: 'File not read before write',
};

const EXTERNAL_MOD_DETAIL: Record<WriteOperation, string> = {
  edit: 'before editing',
  write: 'before writing',
};

/**
 * 执行写入前校验。返回 blocked 结果（应直接返回给调用方）或 snapshotCreated 状态。
 */
export async function runWriteGuard(params: WriteGuardParams): Promise<WriteGuardResult> {
  const { filePath, sessionId, messageId, operation, fileExists } = params;

  if (fileExists && sessionId) {
    const tracker = FileAccessTracker.getInstance();

    if (!tracker.hasFileBeenRead(filePath, sessionId)) {
      return {
        blocked: {
          status: 'error',
          model: NOT_READ_MESSAGES[operation],
          error: {
            type: ToolErrorType.VALIDATION_ERROR,
            message: NOT_READ_ERROR_MESSAGES[operation],
          },
          metadata: { requiresRead: true },
        },
        snapshotCreated: false,
      };
    }

    const externalModCheck = await tracker.checkExternalModification(filePath);
    if (externalModCheck.isExternal) {
      return {
        blocked: {
          status: 'error',
          model: `The file has been modified by an external program since you last read it. You must use the Read tool again to see the current content ${EXTERNAL_MOD_DETAIL[operation]}.\n\nDetails: ${externalModCheck.message}`,
          error: {
            type: ToolErrorType.VALIDATION_ERROR,
            message: 'File modified externally',
            details: { externalModification: externalModCheck.message },
          },
        },
        snapshotCreated: false,
      };
    }
  }

  if (fileExists && sessionId && messageId) {
    try {
      const snapshotManager = new SnapshotManager({ sessionId });
      await snapshotManager.initialize();
      await snapshotManager.createSnapshot(filePath, messageId);
      return { blocked: null, snapshotCreated: true };
    } catch (error) {
      console.warn(`[${operation === 'edit' ? 'EditTool' : 'WriteTool'}] 创建快照失败:`, error);
    }
  }

  return { blocked: null, snapshotCreated: false };
}

/**
 * 写入完成后记录文件访问追踪。
 */
export async function recordWriteComplete(
  filePath: string,
  sessionId: SessionId | undefined,
  operation: WriteOperation,
): Promise<void> {
  if (!sessionId) return;
  const tracker = FileAccessTracker.getInstance();
  await tracker.recordFileEdit(filePath, sessionId, operation);
}
