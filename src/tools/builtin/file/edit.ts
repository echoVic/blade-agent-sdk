import { basename } from 'node:path';
import Type from 'typebox';
import { getFileSystemService } from '../../../services/FileSystemService.js';
import { getErrorCode, getErrorMessage } from '../../../utils/errorUtils.js';
import { ToolKind } from '../../behavior.js';
import { createTool } from '../../core/createTool.js';
import type { EditMetadata } from '../../types/metadata.js';
import { ToolErrorType } from '../../types/result.js';
import { ToolSchemas } from '../../validation/toolSchemas.js';
import { generateDiffSnippetWithMatch } from './diffUtils.js';
import { flexibleMatch, type MatchResult, MatchStrategy, unescapeString } from './editCorrector.js';
import {
  filePermission,
  operationFailure,
  recordWriteComplete,
  runWriteGuard,
  validateFilePath,
} from './operationCore.js';
import { isSensitivePath } from './sensitivePathCheck.js';

export const editTool = createTool({
  name: 'Edit',
  group: 'filesystem',
  displayName: 'File Edit',
  kind: ToolKind.Write,
  sideEffect: 'non_idempotent',
  strict: true,
  isConcurrencySafe: false,
  schema: Type.Object({
    file_path: ToolSchemas.filePath({ description: 'Absolute path of the file to edit' }),
    old_string: Type.String({ minLength: 1, description: 'String to replace' }),
    new_string: Type.String({ description: 'Replacement string, which may be empty' }),
    replace_all: Type.Boolean({ default: false, description: 'Replace every match' }),
  }),
  resolveBehavior: (params) => ({
    kind: ToolKind.Write,
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: params ? isSensitivePath(params.file_path) : false,
  }),
  validateInput: async (params, context) => {
    const pathError = await validateFilePath(params, 'file_path', context);
    return (
      pathError ??
      (params.old_string === params.new_string
        ? {
            message: 'New string is identical to old string',
            model: 'New string is identical; no replacement needed',
          }
        : undefined)
    );
  },
  description: {
    short: 'Replace exact text in a local file',
    usageNotes: [
      'Read the file before editing it',
      'Provide enough surrounding context for a unique match',
      'Use replace_all only when every occurrence should change',
    ],
  },
  async *execute(params, context) {
    const {
      file_path: filePath,
      old_string: oldString,
      new_string: newString,
      replace_all: replaceAll,
    } = params;
    const { sessionId, messageId } = context;
    const signal = context.signal ?? new AbortController().signal;
    const fs = getFileSystemService();
    yield { kind: 'message', content: { summary: 'Starting to read file...' } };

    try {
      let content: string;
      try {
        content = await fs.readTextFile(filePath);
      } catch (error) {
        if (getErrorCode(error) === 'ENOENT' || getErrorMessage(error).includes('not found')) {
          return {
            status: 'error',
            model: `File not found: ${filePath}`,
            error: { type: ToolErrorType.EXECUTION_ERROR, message: '文件不存在' },
          };
        }
        throw error;
      }
      signal.throwIfAborted();
      const guard = await runWriteGuard({
        filePath,
        sessionId,
        messageId,
        operation: 'edit',
        fileExists: true,
        storageRoot: context.bladeConfig?.storageRoot,
      });
      if (guard.blocked) return guard.blocked;

      const match = smartMatch(content, oldString);
      if (!match.matched) {
        return {
          status: 'error',
          model: `String not found in ${filePath}. Read the file again and provide an exact match with surrounding context.`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '未找到匹配内容',
            details: { searchStringLength: oldString.length },
          },
        };
      }
      const locations = locateMatches(content, match.matched);
      if (locations.length > 1 && !replaceAll) {
        return {
          status: 'error',
          model: `old_string matches ${locations.length} locations. Include more context or set replace_all=true.`,
          error: {
            type: ToolErrorType.VALIDATION_ERROR,
            message: 'old_string is not unique',
            details: { matches: locations, count: locations.length },
          },
        };
      }

      yield {
        kind: 'progress',
        message: `找到 ${locations.length} 个匹配项，开始替换...`,
        data: { matches: locations.length },
      };
      const newContent = replaceAll
        ? content.split(match.matched).join(newString)
        : replaceFirst(content, match.matched, newString);
      const replacedCount = replaceAll ? locations.length : 1;
      signal.throwIfAborted();
      await fs.writeTextFile(filePath, newContent);
      await recordWriteComplete(filePath, sessionId, 'edit');
      const stats = await fs.stat(filePath);
      const metadata: EditMetadata = {
        file_path: filePath,
        matches_found: locations.length,
        replacements_made: replacedCount,
        replace_all: replaceAll,
        old_string_length: oldString.length,
        new_string_length: newString.length,
        original_size: content.length,
        new_size: newContent.length,
        size_diff: newContent.length - content.length,
        last_modified: stats?.mtime.toISOString(),
        snapshot_created: guard.snapshotCreated,
        snapshot_warning: guard.snapshotWarning,
        session_id: sessionId,
        message_id: messageId,
        diff_snippet: generateDiffSnippetWithMatch(
          content,
          newContent,
          match.matched,
          newString,
          4,
        ),
        summary: `替换 ${replacedCount} 处匹配到 ${basename(filePath)}`,
        kind: 'edit',
        oldContent: content,
        newContent,
      };
      return {
        status: 'success',
        model: {
          file_path: filePath,
          replacements: replacedCount,
          total_matches: locations.length,
        },
        metadata,
      };
    } catch (error) {
      return operationFailure('File edit', error, 'File edit aborted');
    }
  },
  preparePermissionMatcher: ({ file_path }) => filePermission(file_path),
});

function smartMatch(content: string, search: string): MatchResult {
  if (content.includes(search)) return { matched: search, strategy: MatchStrategy.EXACT };
  const normalize = (value: string) =>
    value
      .replaceAll('\u2018', "'")
      .replaceAll('\u2019', "'")
      .replaceAll('\u201c', '"')
      .replaceAll('\u201d', '"');
  const normalizedIndex = normalize(content).indexOf(normalize(search));
  if (normalizedIndex >= 0) {
    return {
      matched: content.slice(normalizedIndex, normalizedIndex + search.length),
      strategy: MatchStrategy.NORMALIZE_QUOTES,
    };
  }
  const unescaped = unescapeString(search);
  if (unescaped !== search && content.includes(unescaped)) {
    return { matched: unescaped, strategy: MatchStrategy.UNESCAPE };
  }
  const flexible = flexibleMatch(content, search);
  return flexible
    ? { matched: flexible, strategy: MatchStrategy.FLEXIBLE }
    : { matched: null, strategy: MatchStrategy.FAILED };
}

function replaceFirst(content: string, search: string, replacement: string): string {
  const index = content.indexOf(search);
  return content.slice(0, index) + replacement + content.slice(index + search.length);
}

function locateMatches(content: string, search: string): Array<{ line: number; column: number }> {
  const locations: Array<{ line: number; column: number }> = [];
  for (
    let index = content.indexOf(search);
    index >= 0;
    index = content.indexOf(search, index + search.length)
  ) {
    const before = content.slice(0, index);
    const lines = before.split(/\r\n|\n|\r/);
    locations.push({ line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 });
  }
  return locations;
}
