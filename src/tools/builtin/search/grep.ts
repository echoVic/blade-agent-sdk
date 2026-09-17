import Type from 'typebox';
import { getErrorMessage, getErrorName } from '../../../utils/errorUtils.js';
import { toJsonValue } from '../../../utils/jsonValue.js';
import { ToolKind } from '../../behavior.js';
import { createTool } from '../../core/createTool.js';
import type { GrepMetadata } from '../../types/metadata.js';
import { ToolErrorType } from '../../types/result.js';
import { ToolSchemas } from '../../validation/toolSchemas.js';
import { buildRipgrepArgs, runRipgrep, validateSearchPath } from './searchRunner.js';

interface GrepMatch {
  file_path: string;
  line_number?: number;
  content?: string;
  count?: number;
}

type OutputMode = 'content' | 'files_with_matches' | 'count';

export const grepTool = createTool({
  name: 'Grep',
  group: 'filesystem',
  displayName: '内容搜索',
  kind: ToolKind.ReadOnly,
  sideEffect: 'pure',
  interruptBehavior: 'cancel',
  maxResultSizeChars: 100_000,
  schema: Type.Object({
    pattern: ToolSchemas.pattern({
      description: 'The regular expression pattern to search for in file contents',
    }),
    path: Type.Optional(
      Type.String({
        description: 'File or directory to search in. Defaults to the current working directory',
      }),
    ),
    glob: Type.Optional(
      Type.String({ description: 'Glob pattern to filter files, for example "*.{ts,tsx}"' }),
    ),
    type: Type.Optional(
      Type.String({ description: 'Ripgrep file type such as js, py, rust, or go' }),
    ),
    output_mode: Type.Enum(['content', 'files_with_matches', 'count'], {
      default: 'files_with_matches',
      description: 'Return matching content, file paths, or per-file match counts',
    }),
    '-i': Type.Optional(Type.Boolean({ description: 'Case insensitive search' })),
    '-n': Type.Boolean({
      default: true,
      description: 'Show line numbers when output_mode is content',
    }),
    '-B': Type.Optional(
      Type.Integer({ minimum: 0, description: 'Context lines before each content match' }),
    ),
    '-A': Type.Optional(
      Type.Integer({ minimum: 0, description: 'Context lines after each content match' }),
    ),
    '-C': Type.Optional(
      Type.Integer({ minimum: 0, description: 'Context lines before and after content matches' }),
    ),
    head_limit: Type.Optional(
      Type.Integer({ minimum: 1, description: 'Maximum returned lines or entries' }),
    ),
    offset: Type.Optional(
      Type.Integer({ minimum: 0, description: 'Entries to skip before applying head_limit' }),
    ),
    multiline: Type.Boolean({
      default: false,
      description: 'Allow patterns to span lines and dot to match newlines',
    }),
  }),
  validateInput: validateSearchPath,
  description: {
    short: 'Search file contents with ripgrep',
    long: 'Supports regular expressions, glob and file-type filters, context, counts, and multiline search.',
    usageNotes: [
      'Use Grep instead of invoking grep or rg through Bash',
      'Use output_mode "content" when matching lines are needed',
      'Use the Agent tool for open-ended searches requiring multiple rounds',
    ],
  },
  async *execute(params, context) {
    const {
      pattern,
      glob,
      type,
      output_mode: outputMode,
      '-i': caseInsensitive = false,
      '-n': lineNumbers,
      '-B': contextBefore,
      '-A': contextAfter,
      '-C': contextLines,
      head_limit: headLimit,
      offset = 0,
      multiline,
    } = params;
    const searchPath = params.path as string;
    const signal = context.signal ?? new AbortController().signal;
    yield {
      kind: 'progress',
      message: `Searching for pattern "${pattern}"...`,
      data: { pattern },
    };

    try {
      const result = await runRipgrep(
        buildRipgrepArgs({
          pattern,
          path: searchPath,
          glob,
          type,
          outputMode,
          caseInsensitive,
          lineNumbers,
          contextBefore,
          contextAfter,
          context: contextLines,
          multiline,
        }),
        signal,
      );
      if (result.exitCode > 1) {
        return {
          status: 'error',
          model: `Search execution failed: ${result.stderr}`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: result.stderr || `ripgrep exited with code ${result.exitCode}`,
          },
        };
      }

      const parsed = parseGrepOutput(result.stdout, outputMode);
      const matches = parsed.slice(
        offset,
        headLimit === undefined ? undefined : offset + headLimit,
      );
      const metadata: GrepMetadata = {
        search_pattern: pattern,
        search_path: searchPath,
        output_mode: outputMode,
        case_insensitive: caseInsensitive,
        total_matches: matches.length,
        original_total: parsed.length,
        offset,
        head_limit: headLimit,
        strategy: 'ripgrep',
        exit_code: result.exitCode,
        summary: `搜索 "${pattern}": 找到 ${matches.length} 个匹配`,
      };
      return { status: 'success', model: toJsonValue(matches), metadata };
    } catch (error) {
      const aborted = signal.aborted || getErrorName(error) === 'AbortError';
      return {
        status: 'error',
        model: aborted ? 'Search aborted' : `Search failed: ${getErrorMessage(error)}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
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

function parseGrepOutput(output: string, mode: OutputMode): GrepMatch[] {
  const lines = output.trim() ? output.trimEnd().split(/\r?\n/) : [];
  if (mode === 'files_with_matches') {
    return lines.map((file_path) => ({ file_path }));
  }
  if (mode === 'count') {
    return lines.flatMap((line) => {
      const match = /^(.*):(\d+)$/.exec(line);
      return match ? [{ file_path: match[1], count: Number(match[2]) }] : [];
    });
  }
  return lines.flatMap((line) => {
    const numbered = /^(.*?):(\d+):(.*)$/.exec(line);
    if (numbered) {
      return [
        {
          file_path: numbered[1],
          line_number: Number(numbered[2]),
          content: numbered[3],
        },
      ];
    }
    const plain = /^(.*?):(.*)$/.exec(line);
    return plain ? [{ file_path: plain[1], content: plain[2] }] : [];
  });
}
