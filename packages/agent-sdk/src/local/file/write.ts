import { basename, dirname, extname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { createTool, ToolErrorType, ToolKind } from '../../tools/index.js';
import type { ExecutionContext, ToolResult } from '../../tools/types/index.js';
import { generateDiffSnippet } from './diffUtils.js';
import { FileAccessTracker } from './fileAccessTracker.js';
import {
  createNodeLocalFileSystem,
  type LocalFileSystemPort,
} from './filesystem.js';
import { isSensitivePath } from './sensitivePathCheck.js';
import { SnapshotManager } from './snapshotManager.js';

const writeSchema = z.object({
  file_path: z.string().min(1)
    .refine(isAbsolute, 'File path must be absolute')
    .describe('Absolute file path to write'),
  content: z.string().describe('Content to write'),
  encoding: z.enum(['utf8', 'base64']).optional().describe('File encoding'),
  create_directories: z
    .boolean()
    .optional()
    .describe('Automatically create missing parent directories'),
});

export interface WriteToolOptions {
  fileSystem?: LocalFileSystemPort;
  fileAccessTracker?: Pick<FileAccessTracker, 'recordFileEdit' | 'hasFileBeenRead'>;
  snapshotManagerProvider?: (sessionId: string) => SnapshotManager | undefined;
  sensitivePathCheck?: (filePath: string) => boolean;
}

export function createWriteTool(options: WriteToolOptions = {}) {
  const fileSystem = options.fileSystem ?? createNodeLocalFileSystem();
  const fileAccessTracker = options.fileAccessTracker ?? FileAccessTracker.getInstance();
  const snapshotManagerProvider = options.snapshotManagerProvider ?? (() => undefined);
  const checkSensitivePath = options.sensitivePathCheck ?? isSensitivePath;

  function getErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
      return undefined;
    }
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }

  function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(1)}${units[unitIndex]}`;
  }

  return createTool({
    name: 'Write',
    displayName: 'File Write',
    kind: ToolKind.Write,
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: false,
    schema: writeSchema,
    description: {
      short: 'Writes a file to the local filesystem',
      long: 'Writes a file to the local filesystem.',
      usageNotes: [
        'This tool will overwrite the existing file if there is one at the provided path.',
        "If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.",
        'ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.',
        'NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.',
        'Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.',
      ],
    },
    resolveBehavior: ({ file_path }) => {
      const isDestructive = checkSensitivePath(file_path);
      return {
        kind: ToolKind.Write,
        isReadOnly: false,
        isConcurrencySafe: false,
        isDestructive,
      };
    },
    validateInput: (_params, context) => {
      const filesystemRoots = context.contextSnapshot?.filesystemRoots;
      if (!filesystemRoots || filesystemRoots.length === 0) {
        return {
          message: 'No filesystem access in current context',
          llmContent: 'No filesystem access in the current runtime context.',
          errorType: ToolErrorType.PERMISSION_DENIED,
        };
      }
      return undefined;
    },
    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      const { file_path: filePath, content, encoding = 'utf8', create_directories = true } = params;
      const signal = context.signal ?? new AbortController().signal;

      try {
        await context.updateOutput?.('Starting file write...');

        if (create_directories) {
          const dir = dirname(filePath);
          try {
            await fileSystem.mkdir(dir, { recursive: true, mode: 0o755 });
          } catch (error) {
            if (getErrorCode(error) !== 'EEXIST') {
              throw error;
            }
          }
        }

        signal.throwIfAborted();

        let oldContent: string | null = null;
        let fileExisted = false;
        try {
          fileExisted = await fileSystem.exists(filePath);
          if (fileExisted && context.sessionId) {
            if (!fileAccessTracker.hasFileBeenRead(filePath)) {
              return {
                success: false,
                llmContent: `Must read file "${filePath}" before writing to it. Use the Read tool first.`,
                error: {
                  type: ToolErrorType.PERMISSION_DENIED,
                  message: `File not read: ${filePath}`,
                },
              };
            }
            oldContent = encoding === 'utf8'
              ? await fileSystem.readTextFile(filePath)
              : null;
          }
        } catch {
          // If we can't read the old content, proceed without diff
        }

        signal.throwIfAborted();

        if (encoding === 'utf8') {
          await fileSystem.writeTextFile(filePath, content);
        } else {
          const binaryContent = Buffer.from(content, 'base64');
          await fileSystem.writeTextFile(filePath, binaryContent.toString('utf8'));
        }

        const stats = await fileSystem.stat(filePath);

        const snapshotManager = context.sessionId
          ? snapshotManagerProvider(context.sessionId)
          : undefined;
        let snapshotCreated = false;
        if (snapshotManager && context.messageId && fileExisted && encoding === 'utf8') {
          try {
            await snapshotManager.createSnapshot(filePath, context.messageId);
            snapshotCreated = true;
          } catch {
            // best-effort snapshot
          }
        }

        if (context.sessionId) {
          try {
            await fileAccessTracker.recordFileEdit(filePath, context.sessionId, 'write');
          } catch {
            // best-effort tracking
          }
        }

        const diffSnippet = oldContent !== null
          ? generateDiffSnippet(oldContent, content)
          : null;

        const lineCount = content.split('\n').length;
        const fileName = basename(filePath);
        const extension = extname(filePath).toLowerCase();

        const metadata: Record<string, unknown> = {
          file_path: filePath,
          file_name: fileName,
          file_extension: extension,
          file_size: stats?.size,
          lines_written: lineCount,
          encoding,
          create_directories,
          snapshot_created: snapshotCreated,
          session_id: context.sessionId,
          message_id: context.messageId,
          last_modified: stats?.mtime instanceof Date ? stats.mtime.toISOString() : undefined,
          has_diff: !!diffSnippet,
          summary: encoding === 'utf8'
            ? `Wrote ${lineCount} lines to ${fileName}`
            : `Wrote ${stats?.size ? formatFileSize(stats.size) : 'unknown'} to ${fileName}`,
          kind: 'edit',
          oldContent: oldContent ?? '',
          newContent: encoding === 'utf8' ? content : undefined,
        };

        return {
          success: true,
          llmContent: {
            file_path: filePath,
            size: stats?.size,
            modified: stats?.mtime instanceof Date ? stats.mtime.toISOString() : undefined,
          },
          metadata,
        };
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return {
            success: false,
            llmContent: 'File write aborted',
            error: {
              type: ToolErrorType.EXECUTION_ERROR,
              message: 'Operation aborted',
            },
          };
        }

        return {
          success: false,
          llmContent: `File write failed: ${getErrorMessage(error)}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: getErrorMessage(error),
            details: error,
          },
        };
      }
    },
    version: '3.0.0',
    category: 'file',
    tags: ['file', 'io', 'write', 'create'],
    preparePermissionMatcher: (params) => {
      const ext = extname(params.file_path);
      return {
        signatureContent: params.file_path,
        abstractRule: ext ? `**/*${ext}` : '**/*',
      };
    },
  });
}

export const writeTool = createWriteTool();

