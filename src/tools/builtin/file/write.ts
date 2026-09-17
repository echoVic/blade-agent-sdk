import { writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import Type from 'typebox';
import { getFileSystemService } from '../../../services/FileSystemService.js';
import { toJsonValue } from '../../../utils/jsonValue.js';
import { ToolKind } from '../../behavior.js';
import { createTool } from '../../core/createTool.js';
import type { WriteMetadata } from '../../types/metadata.js';
import { ToolSchemas } from '../../validation/toolSchemas.js';
import { generateDiffSnippet } from './diffUtils.js';
import {
  filePermission,
  operationFailure,
  recordWriteComplete,
  runWriteGuard,
  validateFilePath,
} from './operationCore.js';
import { isSensitivePath } from './sensitivePathCheck.js';

export const writeTool = createTool({
  name: 'Write',
  group: 'filesystem',
  displayName: 'File Write',
  kind: ToolKind.Write,
  sideEffect: 'idempotent',
  strict: true,
  isConcurrencySafe: false,
  schema: Type.Object({
    file_path: ToolSchemas.filePath({ description: 'Absolute file path to write' }),
    content: Type.String({ description: 'Content to write' }),
    encoding: ToolSchemas.encoding(),
    create_directories: Type.Boolean({
      default: true,
      description: 'Create missing parent directories',
    }),
  }),
  resolveBehavior: (params) => ({
    kind: ToolKind.Write,
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: params ? isSensitivePath(params.file_path) : false,
  }),
  validateInput: (params, context) => validateFilePath(params, 'file_path', context, true),
  description: {
    short: 'Write a local file',
    usageNotes: [
      'Read an existing file before overwriting it',
      'Prefer Edit for focused changes to existing files',
      'Create documentation only when the user requests it',
    ],
  },
  async *execute(params, context) {
    const {
      file_path: filePath,
      content,
      encoding,
      create_directories: createDirectories,
    } = params;
    const { sessionId, messageId } = context;
    const signal = context.signal ?? new AbortController().signal;
    const fs = getFileSystemService();
    yield { kind: 'message', content: { summary: '开始写入文件...' } };

    try {
      if (createDirectories) await fs.mkdir(dirname(filePath), { recursive: true, mode: 0o755 });
      signal.throwIfAborted();
      const exists = await fs.exists(filePath);
      const oldContent = exists && encoding === 'utf8' ? await readExistingText(filePath) : null;
      const guard = await runWriteGuard({
        filePath,
        sessionId,
        messageId,
        operation: 'write',
        fileExists: exists,
        storageRoot: context.bladeConfig?.storageRoot,
      });
      if (guard.blocked) return guard.blocked;
      signal.throwIfAborted();

      if (encoding === 'utf8') await fs.writeTextFile(filePath, content);
      else await writeFile(filePath, Buffer.from(content, encoding));
      await recordWriteComplete(filePath, sessionId, 'write');
      signal.throwIfAborted();

      const stats = await fs.stat(filePath);
      const modified = stats?.mtime.toISOString();
      const diff =
        oldContent !== null &&
        oldContent !== content &&
        oldContent.length < 1_048_576 &&
        content.length < 1_048_576
          ? generateDiffSnippet(oldContent, content, 4)
          : null;
      const metadata: WriteMetadata = {
        file_path: filePath,
        content_size: content.length,
        file_size: stats?.size,
        encoding,
        created_directories: createDirectories,
        snapshot_created: guard.snapshotCreated,
        snapshot_warning: guard.snapshotWarning,
        session_id: sessionId,
        message_id: messageId,
        last_modified: modified,
        has_diff: Boolean(diff),
        summary:
          encoding === 'utf8'
            ? `写入 ${content.split('\n').length} 行到 ${basename(filePath)}`
            : `写入 ${stats?.size ?? 0} bytes 到 ${basename(filePath)}`,
        kind: 'edit',
        oldContent: oldContent ?? '',
        newContent: encoding === 'utf8' ? content : undefined,
      };
      return {
        status: 'success',
        model: toJsonValue({ file_path: filePath, size: stats?.size, modified }),
        metadata,
      };
    } catch (error) {
      return operationFailure('File write', error, 'File write aborted');
    }
  },
  preparePermissionMatcher: ({ file_path }) => filePermission(file_path),
});

async function readExistingText(filePath: string): Promise<string | null> {
  try {
    return await getFileSystemService().readTextFile(filePath);
  } catch {
    return null;
  }
}
