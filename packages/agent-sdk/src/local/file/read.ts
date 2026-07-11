import { basename, extname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { createTool, ToolErrorType, ToolKind } from '../../tools/index.js';
import type { ExecutionContext, ToolResult } from '../../tools/types/index.js';
import { FileAccessTracker } from './fileAccessTracker.js';
import {
  createNodeLocalFileSystem,
  type LocalFileSystemPort,
} from './filesystem.js';

const readSchema = z.object({
  file_path: z.string().min(1)
    .refine(isAbsolute, 'File path must be absolute')
    .describe('Absolute file path to read'),
  offset: z.number().int().min(0).optional().describe('Starting line number, zero-based'),
  limit: z.number().int().positive().optional().describe('Number of lines to read'),
  encoding: z.enum(['utf8', 'base64', 'binary']).optional(),
});

export interface ReadToolOptions {
  fileSystem?: LocalFileSystemPort;
  fileAccessTracker?: Pick<FileAccessTracker, 'recordFileRead'>;
}

export function createReadTool(options: ReadToolOptions = {}) {
  const fileSystem = options.fileSystem ?? createNodeLocalFileSystem();
  const fileAccessTracker = options.fileAccessTracker ?? FileAccessTracker.getInstance();

  return createTool({
    name: 'Read',
    displayName: 'File Read',
    kind: ToolKind.ReadOnly,
    isReadOnly: true,
    isConcurrencySafe: true,
    maxResultSizeChars: 500_000,
    schema: readSchema,
    description: {
      short: 'Read files from the local filesystem',
      long: 'Reads text or binary files from an explicitly enabled filesystem context.',
      usageNotes: [
        'file_path must be absolute',
        'offset is zero-based and applies only to UTF-8 text files',
        'long text lines are truncated to 2000 characters',
      ],
    },
    validateInput: (_params, context) => {
      if ((context.contextSnapshot?.filesystemRoots.length ?? 0) === 0) {
        return {
          message: 'No filesystem access in current context',
          llmContent: 'No filesystem access in the current runtime context.',
          errorType: ToolErrorType.PERMISSION_DENIED,
        };
      }
      return undefined;
    },
    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      const { file_path: filePath, offset, limit, encoding = 'utf8' } = params;
      const signal = context.signal ?? new AbortController().signal;

      try {
        await context.updateOutput?.('Starting file read...');

        if (!(await fileSystem.exists(filePath))) {
          return failureResult(`File not found: ${filePath}`);
        }

        signal.throwIfAborted();

        if (context.sessionId) {
          await fileAccessTracker.recordFileRead(filePath, context.sessionId);
        }

        const stats = await fileSystem.stat(filePath);
        if (!stats) {
          return failureResult(`File not found: ${filePath}`);
        }
        if (stats.isDirectory) {
          return failureResult(`Cannot read a directory: ${filePath}`, 'Target is a directory, not a file');
        }

        const extension = extname(filePath).toLowerCase();
        const isTextFile = isTextExtension(extension);
        const isBinaryFile = isBinaryExtension(extension);
        let resolvedEncoding = encoding;
        let content: string;
        let isBinary = false;

        if (isBinaryFile && encoding === 'utf8') {
          await context.updateOutput?.('Detected binary file, using base64 encoding...');
          content = encodeBytes(await fileSystem.readBinaryFile(filePath), 'base64');
          resolvedEncoding = 'base64';
          isBinary = true;
        } else if (isTextFile && encoding === 'utf8') {
          content = await fileSystem.readTextFile(filePath);
        } else {
          content = encodeBytes(await fileSystem.readBinaryFile(filePath), encoding);
          isBinary = !isTextFile;
        }

        signal.throwIfAborted();

        const metadata: Record<string, unknown> = {
          file_path: filePath,
          file_size: stats.size,
          file_type: extension,
          last_modified: stats.mtime.toISOString(),
          encoding: resolvedEncoding,
          ...(isBinary ? { is_binary: true } : {}),
        };

        if ((offset !== undefined || limit !== undefined) && encoding === 'utf8' && isTextFile) {
          const lines = content.split('\n');
          const startLine = offset ?? 0;
          const endLine = limit === undefined ? lines.length : startLine + limit;
          const selectedLines = lines.slice(startLine, endLine);
          content = selectedLines
            .map((line, index) => {
              const lineNumber = startLine + index + 1;
              const truncated = line.length > 2000 ? `${line.slice(0, 2000)}...` : line;
              return `${lineNumber.toString().padStart(6)}→${truncated}`;
            })
            .join('\n');
          metadata.lines_read = selectedLines.length;
          metadata.total_lines = lines.length;
          metadata.start_line = startLine + 1;
          metadata.end_line = Math.min(endLine, lines.length);
        }

        const linesRead = metadata.lines_read ?? metadata.total_lines;
        metadata.summary = typeof linesRead === 'number'
          ? `Read ${linesRead} lines from ${basename(filePath)}`
          : `Read ${basename(filePath)}`;

        return {
          success: true,
          llmContent: content,
          metadata,
        };
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          return failureResult('File read aborted', 'Operation aborted');
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        return failureResult(`File read failed: ${errorMessage}`, errorMessage, error);
      }
    },
    version: '3.0.0',
    category: 'file',
    tags: ['file', 'io', 'read'],
    preparePermissionMatcher: (params) => {
      const extension = extname(params.file_path);
      return {
        signatureContent: params.file_path,
        abstractRule: extension ? `**/*${extension}` : '**/*',
      };
    },
  });
}

function failureResult(llmContent: string, message = llmContent, details?: unknown): ToolResult {
  return {
    success: false,
    llmContent,
    error: {
      type: ToolErrorType.EXECUTION_ERROR,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function encodeBytes(bytes: Uint8Array, encoding: 'utf8' | 'base64' | 'binary'): string {
  return Buffer.from(bytes).toString(encoding);
}

function isTextExtension(extension: string): boolean {
  return extension === '' || TEXT_EXTENSIONS.has(extension);
}

function isBinaryExtension(extension: string): boolean {
  return BINARY_EXTENSIONS.has(extension);
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.js', '.ts', '.jsx', '.tsx', '.json', '.xml', '.html', '.htm',
  '.css', '.scss', '.sass', '.less', '.yml', '.yaml', '.toml', '.ini', '.cfg',
  '.py', '.rb', '.php', '.java', '.cpp', '.c', '.h', '.hpp', '.rs', '.go', '.sh',
  '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd', '.sql', '.graphql', '.vue',
  '.svelte', '.astro', '.dockerfile', '.gitignore', '.env',
]);

const BINARY_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.ico', '.webp', '.mp3', '.wav',
  '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.pdf', '.doc', '.docx', '.xls',
  '.xlsx', '.ppt', '.pptx', '.zip', '.tar', '.gz', '.rar', '.7z', '.exe', '.dll',
  '.so', '.ttf', '.otf', '.woff', '.woff2', '.eot',
]);

export const readTool = createReadTool();
