import { basename, extname } from 'node:path';
import Type from 'typebox';
import { getFileSystemService } from '../../../services/FileSystemService.js';
import { ToolKind } from '../../behavior.js';
import { createTool } from '../../core/createTool.js';
import type { ReadMetadata } from '../../types/metadata.js';
import { ToolErrorType } from '../../types/result.js';
import { ToolSchemas } from '../../validation/toolSchemas.js';
import { FileAccessTracker } from './FileAccessTracker.js';
import { filePermission, operationFailure, validateFilePath } from './operationCore.js';

const TEXT_EXTENSIONS = new Set(
  '.txt .md .js .ts .jsx .tsx .json .xml .html .htm .css .scss .sass .less .yml .yaml .toml .ini .cfg .py .rb .php .java .cpp .c .h .hpp .rs .go .sh .bash .zsh .fish .ps1 .bat .cmd .sql .graphql .vue .svelte .astro .dockerfile .gitignore .env'.split(
    ' ',
  ),
);
const BINARY_EXTENSIONS = new Set(
  '.jpg .jpeg .png .gif .bmp .svg .ico .webp .mp3 .wav .mp4 .avi .mov .wmv .flv .webm .pdf .doc .docx .xls .xlsx .ppt .pptx .zip .tar .gz .rar .7z .exe .dll .so .ttf .otf .woff .woff2 .eot'.split(
    ' ',
  ),
);

export function truncateTextLine(line: string, maxCodePoints = 2000): string {
  const codePoints = Array.from(line);
  return codePoints.length > maxCodePoints
    ? `${codePoints.slice(0, maxCodePoints).join('')}...`
    : line;
}

export const readTool = createTool({
  name: 'Read',
  group: 'filesystem',
  displayName: 'File Read',
  kind: ToolKind.ReadOnly,
  sideEffect: 'pure',
  interruptBehavior: 'cancel',
  maxResultSizeChars: 500_000,
  schema: Type.Object({
    file_path: ToolSchemas.filePath({ description: 'Absolute file path to read' }),
    offset: Type.Optional(
      ToolSchemas.lineNumber({ description: 'Zero-based starting line for text files' }),
    ),
    limit: Type.Optional(ToolSchemas.lineLimit({ description: 'Number of text lines to read' })),
    encoding: ToolSchemas.encoding(),
  }),
  validateInput: (params, context) => validateFilePath(params, 'file_path', context),
  description: {
    short: 'Read a local file',
    long: 'Reads text with optional line ranges and returns binary files using the requested encoding.',
    usageNotes: [
      'Use an absolute file path',
      'Read existing files before changing them with Write or Edit',
      'Use Bash to inspect directories',
    ],
  },
  async *execute(params, context) {
    const { file_path: filePath, offset, limit, encoding } = params;
    const signal = context.signal ?? new AbortController().signal;
    const fs = getFileSystemService();
    yield { kind: 'message', content: { summary: 'Starting file read...' } };

    try {
      if (!(await fs.exists(filePath))) {
        return {
          status: 'error',
          model: `File not found: ${filePath}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: `File not found: ${filePath}`,
          },
        };
      }
      signal.throwIfAborted();
      const stats = await fs.stat(filePath);
      if (stats?.isDirectory) {
        return {
          status: 'error',
          model: `Cannot read a directory: ${filePath}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: 'Target is a directory, not a file',
          },
        };
      }

      const extension = extname(filePath).toLowerCase();
      const textFile = extension === '' || TEXT_EXTENSIONS.has(extension);
      let trackedContent: string | Buffer;
      let content: string;
      let resultEncoding = encoding;
      if (textFile) {
        trackedContent = await fs.readTextFile(filePath);
        content = trackedContent;
      } else {
        trackedContent = await fs.readBinaryFile(filePath);
        resultEncoding =
          encoding === 'utf8' && BINARY_EXTENSIONS.has(extension) ? 'base64' : encoding;
        content = trackedContent.toString(resultEncoding);
      }
      if (context.sessionId) {
        await FileAccessTracker.getInstance().recordFileRead(
          filePath,
          context.sessionId,
          trackedContent,
        );
      }
      signal.throwIfAborted();

      const metadata: ReadMetadata = {
        file_path: filePath,
        file_size: stats?.size,
        file_type: extension,
        last_modified: stats?.mtime instanceof Date ? stats.mtime.toISOString() : undefined,
        encoding: resultEncoding,
        is_binary: BINARY_EXTENSIONS.has(extension) || undefined,
      };
      if (textFile && (offset !== undefined || limit !== undefined)) {
        const lines = content.split('\n');
        const start = offset ?? 0;
        const selected = lines.slice(start, limit === undefined ? undefined : start + limit);
        content = selected
          .map(
            (line, index) => `${String(start + index + 1).padStart(6)}→${truncateTextLine(line)}`,
          )
          .join('\n');
        Object.assign(metadata, {
          lines_read: selected.length,
          total_lines: lines.length,
          start_line: start + 1,
          end_line: Math.min(start + selected.length, lines.length),
        });
      }
      metadata.summary = metadata.lines_read
        ? `读取 ${metadata.lines_read} 行从 ${basename(filePath)}`
        : `读取 ${basename(filePath)}`;
      return { status: 'success', model: content, metadata };
    } catch (error) {
      return operationFailure('File read', error, 'File read aborted');
    }
  },
  preparePermissionMatcher: ({ file_path }) => filePermission(file_path),
});
