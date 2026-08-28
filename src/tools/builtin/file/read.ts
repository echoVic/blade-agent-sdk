import { basename, extname } from 'node:path';
import { z } from 'zod';
import { getFileSystemService } from '../../../services/FileSystemService.js';
import { getErrorMessage, getErrorName } from '../../../utils/errorUtils.js';
import { createTool } from '../../core/createTool.js';
import type { ExecutionContext } from '../../types/execution.js';
import { ToolKind } from '../../types/kind.js';
import type { ReadMetadata } from '../../types/metadata.js';
import { ToolErrorType } from '../../types/result.js';
import { resolveAuthorizedFilesystemPath } from '../../validation/filesystemPath.js';
import { lazySchema } from '../../validation/lazySchema.js';
import { ToolSchemas } from '../../validation/zodSchemas.js';
import { FileAccessTracker } from './FileAccessTracker.js';

export function truncateTextLine(line: string, maxCodePoints = 2000): string {
  const codePoints = Array.from(line);
  return codePoints.length > maxCodePoints
    ? `${codePoints.slice(0, maxCodePoints).join('')}...`
    : line;
}

/**
 * ReadTool - File read tool
 * Uses the newer Zod validation design
 */
export const readTool = createTool({
  name: 'Read',
  displayName: 'File Read',
  kind: ToolKind.ReadOnly,
  sideEffect: 'pure',
  interruptBehavior: 'cancel',
  maxResultSizeChars: 500_000, // ~500KB — large files get externalized to avoid context bloat

  // Zod Schema 定义
  schema: lazySchema(() =>
    z.object({
      file_path: ToolSchemas.filePath({
        description: 'File path to read (must be absolute)',
      }),
      offset: ToolSchemas.lineNumber({
        description: 'Starting line number (0-based, text files only)',
      }).optional(),
      limit: ToolSchemas.lineLimit({
        description: 'Number of lines to read (text files only)',
      }).optional(),
      encoding: ToolSchemas.encoding(),
    }),
  ),

  validateInput: async (params, context) => {
    try {
      params.file_path = await resolveAuthorizedFilesystemPath(
        params.file_path,
        context.contextSnapshot,
      );
    } catch (error) {
      const message = getErrorMessage(error);
      return {
        message,
        model: message,
        errorType: ToolErrorType.PERMISSION_DENIED,
      };
    }
    return undefined;
  },

  // 工具描述
  description: {
    short: 'Read files from the local filesystem',
    long: `Reads a file from the local filesystem. You can access any file directly by using this tool. Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.`,
    usageNotes: [
      'The file_path parameter must be an absolute path, not a relative path',
      'By default, it reads up to 2000 lines starting from the beginning of the file',
      "You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters",
      'Any lines longer than 2000 characters will be truncated',
      'Results are returned using cat -n format, with line numbers starting at 1',
      'This tool allows reading images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as this is a multimodal LLM.',
      'This tool can read PDF files (.pdf). PDFs are processed page by page, extracting both text and visual content for analysis.',
      'This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.',
      'This tool can only read files, not directories. To read a directory, use an ls command via the Bash tool.',
      'You can call multiple tools in a single response. It is always better to speculatively read multiple potentially useful files in parallel.',
      'You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.',
      'If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.',
    ],
    examples: [
      {
        description: 'Read the entire file (recommended)',
        params: { file_path: '/path/to/file.ts' },
      },
      {
        description: 'Read the first 100 lines',
        params: { file_path: '/path/to/file.txt', limit: 100 },
      },
      {
        description: 'Read 100 lines starting at line 50 (large file)',
        params: { file_path: '/path/to/large-file.log', offset: 50, limit: 100 },
      },
    ],
    important: [
      'file_path must be absolute',
      'Prefer reading the entire file (omit offset and limit)',
      'Use offset/limit only for very large files',
      'Line numbers start at 1 (cat -n format)',
    ],
  },

  // 执行函数
  async *execute(params, context: ExecutionContext) {
    const { file_path, offset, limit, encoding = 'utf8' } = params;
    const { sessionId } = context;
    const signal = context.signal ?? new AbortController().signal;

    try {
      yield {
        kind: 'message',
        content: { summary: 'Starting file read...' },
      };

      // 获取文件系统服务
      const fsService = getFileSystemService();

      // 检查文件是否存在（统一使用 FileSystemService）
      try {
        const exists = await fsService.exists(file_path);
        if (!exists) {
          throw new Error('File not found');
        }
      } catch (_error) {
        return {
          status: 'error',
          model: `File not found: ${file_path}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: `File not found: ${file_path}`,
          },
        };
      }

      // 检查中止信号
      if (typeof signal.throwIfAborted === 'function') {
        signal.throwIfAborted();
      }

      // 获取文件统计信息（统一使用 FileSystemService）
      const stats = await fsService.stat(file_path);

      if (stats?.isDirectory) {
        return {
          status: 'error',
          model: `Cannot read a directory: ${file_path}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: 'Target is a directory, not a file',
          },
        };
      }

      // 获取文件扩展名
      const ext = extname(file_path).toLowerCase();
      const isTextFile = checkIsTextFile(ext);
      const isBinaryFile = checkIsBinaryFile(ext);

      let content: string;
      let trackedContent: string | Buffer;
      const metadata: ReadMetadata = {
        file_path,
        file_size: stats?.size,
        file_type: ext,
        last_modified: stats?.mtime instanceof Date ? stats.mtime.toISOString() : undefined,
        encoding: encoding,
      };

      // 处理二进制文件
      if (isBinaryFile && encoding === 'utf8') {
        yield {
          kind: 'message',
          content: { summary: '检测到二进制文件，使用 base64 编码...' },
        };
        const buffer = await fsService.readBinaryFile(file_path);
        trackedContent = buffer;
        content = buffer.toString('base64');
        metadata.encoding = 'base64';
        metadata.is_binary = true;
      } else if (isTextFile) {
        // 文本文件：使用 FileSystemService 读取
        content = await fsService.readTextFile(file_path);
        trackedContent = content;
      } else {
        // 其他文件：使用二进制读取
        const buffer = await fsService.readBinaryFile(file_path);
        trackedContent = buffer;

        if (encoding === 'base64') {
          content = buffer.toString('base64');
        } else if (encoding === 'binary') {
          content = buffer.toString('binary');
        } else {
          content = buffer.toString('utf8');
        }
      }

      // Record the post-read identity used by the optimistic write guard.
      if (sessionId) {
        const tracker = FileAccessTracker.getInstance();
        await tracker.recordFileRead(file_path, sessionId, trackedContent);
      }

      if (typeof signal.throwIfAborted === 'function') {
        signal.throwIfAborted();
      }

      // 处理行级切片（仅文本文件）
      if ((offset !== undefined || limit !== undefined) && encoding === 'utf8' && isTextFile) {
        const lines = content.split('\n');
        const startLine = offset || 0;
        const endLine = limit !== undefined ? startLine + limit : lines.length;

        const selectedLines = lines.slice(startLine, endLine);
        content = selectedLines
          .map((line, index) => {
            const lineNumber = startLine + index + 1;
            // 截断过长的行
            const truncatedLine = truncateTextLine(line);
            return `${lineNumber.toString().padStart(6)}→${truncatedLine}`;
          })
          .join('\n');

        metadata.lines_read = selectedLines.length;
        metadata.total_lines = lines.length;
        metadata.start_line = startLine + 1;
        metadata.end_line = Math.min(endLine, lines.length);
      }

      // 生成 summary 用于流式显示
      const fileName = basename(file_path);
      const linesRead = metadata.lines_read || metadata.total_lines;
      const summary = linesRead ? `读取 ${linesRead} 行从 ${fileName}` : `读取 ${fileName}`;

      metadata.summary = summary;

      return {
        status: 'success',
        model: content,
        metadata,
      };
    } catch (error) {
      if (getErrorName(error) === 'AbortError') {
        return {
          status: 'error',
          model: 'File read aborted',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: 'Operation aborted',
          },
        };
      }

      return {
        status: 'error',
        model: `File read failed: ${getErrorMessage(error)}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: getErrorMessage(error),
          details: error,
        },
      };
    }
  },

  version: '2.0.0',
  category: '文件操作',
  tags: ['file', 'io', 'read'],

  preparePermissionMatcher: (params) => {
    const ext = extname(params.file_path);
    return {
      signatureContent: params.file_path,
      abstractRule: ext ? `**/*${ext}` : '**/*',
    };
  },
});

/**
 * 检查是否是文本文件
 */
function checkIsTextFile(ext: string): boolean {
  const textExtensions = [
    '.txt',
    '.md',
    '.js',
    '.ts',
    '.jsx',
    '.tsx',
    '.json',
    '.xml',
    '.html',
    '.htm',
    '.css',
    '.scss',
    '.sass',
    '.less',
    '.yml',
    '.yaml',
    '.toml',
    '.ini',
    '.cfg',
    '.py',
    '.rb',
    '.php',
    '.java',
    '.cpp',
    '.c',
    '.h',
    '.hpp',
    '.rs',
    '.go',
    '.sh',
    '.bash',
    '.zsh',
    '.fish',
    '.ps1',
    '.bat',
    '.cmd',
    '.sql',
    '.graphql',
    '.vue',
    '.svelte',
    '.astro',
    '.dockerfile',
    '.gitignore',
    '.env',
  ];
  return textExtensions.includes(ext) || ext === '';
}

/**
 * 检查是否是二进制文件
 */
function checkIsBinaryFile(ext: string): boolean {
  const binaryExtensions = [
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.bmp',
    '.svg',
    '.ico',
    '.webp',
    '.mp3',
    '.wav',
    '.mp4',
    '.avi',
    '.mov',
    '.wmv',
    '.flv',
    '.webm',
    '.pdf',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
    '.zip',
    '.tar',
    '.gz',
    '.rar',
    '.7z',
    '.exe',
    '.dll',
    '.so',
    '.ttf',
    '.otf',
    '.woff',
    '.woff2',
    '.eot',
  ];
  return binaryExtensions.includes(ext);
}

/**
 * 格式化文件大小
 */
function _formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)}${units[unitIndex]}`;
}
