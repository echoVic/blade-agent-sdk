import Type from 'typebox';
import { getErrorMessage, getErrorName } from '../../../utils/errorUtils.js';
import { ToolKind } from '../../behavior.js';
import { createTool } from '../../core/createTool.js';
import type { GlobMetadata } from '../../types/metadata.js';
import { ToolErrorType } from '../../types/result.js';
import { ToolSchemas } from '../../validation/toolSchemas.js';
import {
  requireSearchDirectory,
  runGlob,
  type SearchMatch,
  validateSearchPath,
} from './searchRunner.js';

export const globTool = createTool({
  name: 'Glob',
  group: 'filesystem',
  displayName: 'File Pattern Match',
  kind: ToolKind.ReadOnly,
  sideEffect: 'pure',
  interruptBehavior: 'cancel',
  schema: Type.Object({
    pattern: ToolSchemas.glob({
      description: 'Glob pattern string (supports *, ?, ** wildcards)',
    }),
    path: Type.Optional(Type.String({ description: 'Search path (optional, defaults to cwd)' })),
    max_results: Type.Integer({
      minimum: 1,
      maximum: 1000,
      default: 100,
      description: 'Maximum number of results',
    }),
    include_directories: Type.Boolean({
      default: false,
      description: 'Include directories in results',
    }),
    case_sensitive: Type.Boolean({
      default: false,
      description: 'Case sensitive matching',
    }),
  }),
  validateInput: validateSearchPath,
  description: {
    short: 'Fast file pattern matching tool that works with any codebase size',
    long: 'Finds files with glob patterns and returns matches sorted by modification time.',
    usageNotes: [
      'Use this tool when you need to find files by name patterns',
      'Use the Agent tool for open-ended searches requiring multiple rounds',
    ],
  },
  async *execute(params, context) {
    const { pattern, max_results, include_directories, case_sensitive } = params;
    const searchPath = params.path as string;
    const signal = context.signal ?? new AbortController().signal;
    yield {
      kind: 'progress',
      message: `Searching in ${searchPath} for pattern "${pattern}"...`,
      data: { pattern, searchRoot: searchPath },
    };

    try {
      const root = await requireSearchDirectory(searchPath);
      const { matches, truncated } = await runGlob(root, pattern, {
        maxResults: max_results,
        includeDirectories: include_directories,
        caseSensitive: case_sensitive,
        signal,
      });
      const metadata: GlobMetadata = {
        search_path: root,
        pattern,
        total_matches: matches.length,
        returned_matches: matches.length,
        max_results,
        include_directories,
        case_sensitive,
        truncated,
        matches,
        summary: `找到 ${matches.length} 个匹配 "${pattern}" 的文件`,
      };
      return {
        status: 'success',
        model: formatMatches(pattern, matches, truncated),
        metadata,
      };
    } catch (error) {
      const aborted = getErrorName(error) === 'AbortError';
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      const invalidPath = code === 'SEARCH_PATH_NOT_DIRECTORY';
      return {
        status: 'error',
        model: aborted
          ? 'File search aborted'
          : invalidPath
            ? getErrorMessage(error)
            : `Search failed: ${getErrorMessage(error)}`,
        error: {
          type: invalidPath ? ToolErrorType.VALIDATION_ERROR : ToolErrorType.EXECUTION_ERROR,
          message: aborted ? '操作被中止' : getErrorMessage(error),
          details: error,
        },
      };
    }
  },
  preparePermissionMatcher: (params) => ({
    signatureContent: params.pattern,
    abstractRule: '*',
  }),
});

function formatMatches(pattern: string, matches: SearchMatch[], truncated: boolean): string {
  if (matches.length === 0) return `No files found matching "${pattern}"`;
  const count = truncated
    ? `Found at least ${matches.length} file(s) matching "${pattern}" (truncated)`
    : `Found ${matches.length} file(s) matching "${pattern}"`;
  return `${count}:\n\n${matches.map(({ relative_path }) => `- ${relative_path}`).join('\n')}\n\nUse the relative_path values above for Read/Edit operations.`;
}
