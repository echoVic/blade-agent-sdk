import { basename, extname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { createTool, ToolErrorType, ToolKind } from '../../tools/index.js';
import type { ExecutionContext, ToolResult, ToolResultMetadata } from '../../tools/types/index.js';
import { generateDiffSnippetWithMatch } from './diffUtils.js';
import {
  flexibleMatch,
  type MatchResult,
  MatchStrategy,
  unescapeString,
} from './editCorrector.js';
import { FileAccessTracker } from './fileAccessTracker.js';
import { createNodeLocalFileSystem, type LocalFileSystemPort } from './filesystem.js';
import { isSensitivePath } from './sensitivePathCheck.js';
import { SnapshotManager } from './snapshotManager.js';

const editSchema = z.object({
  file_path: z.string().min(1)
    .refine(isAbsolute, 'File path must be absolute')
    .describe('Absolute path of the file to edit'),
  old_string: z.string().min(1, 'old_string cannot be empty').describe('String to replace'),
  new_string: z.string().describe('Replacement string (can be empty)'),
  replace_all: z.boolean().optional().default(false).describe('Replace all matches (default: first only)'),
});

export interface EditToolOptions {
  fileSystem?: LocalFileSystemPort;
  fileAccessTracker?: Pick<FileAccessTracker, 'recordFileEdit' | 'hasFileBeenRead'>;
  snapshotManagerProvider?: (sessionId: string) => SnapshotManager | undefined;
  sensitivePathCheck?: (filePath: string) => boolean;
}

export function createEditTool(options: EditToolOptions = {}) {
  const fileSystem = options.fileSystem ?? createNodeLocalFileSystem();
  const fileAccessTracker = options.fileAccessTracker ?? FileAccessTracker.getInstance();
  const snapshotManagerProvider = options.snapshotManagerProvider ?? (() => undefined);
  const checkSensitivePath = options.sensitivePathCheck ?? isSensitivePath;

  function getErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }

  function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function getErrorName(error: unknown): string {
    return error instanceof Error ? error.name : String(error);
  }

  function normalizeQuotes(text: string): string {
    return text
      .replaceAll('\u2018', "'")
      .replaceAll('\u2019', "'")
      .replaceAll('\u201c', '"')
      .replaceAll('\u201d', '"');
  }

  function smartMatch(content: string, searchString: string): MatchResult {
    if (content.includes(searchString)) {
      return { matched: searchString, strategy: MatchStrategy.EXACT };
    }

    const normalizedSearch = normalizeQuotes(searchString);
    const normalizedContent = normalizeQuotes(content);
    const quoteIndex = normalizedContent.indexOf(normalizedSearch);
    if (quoteIndex !== -1) {
      const actualString = content.substring(quoteIndex, quoteIndex + searchString.length);
      return { matched: actualString, strategy: MatchStrategy.NORMALIZE_QUOTES };
    }

    const unescaped = unescapeString(searchString);
    if (unescaped !== searchString && content.includes(unescaped)) {
      return { matched: unescaped, strategy: MatchStrategy.UNESCAPE };
    }

    const flexible = flexibleMatch(content, searchString);
    if (flexible) {
      return { matched: flexible, strategy: MatchStrategy.FLEXIBLE };
    }

    return { matched: null, strategy: MatchStrategy.FAILED };
  }

  function findMatchesWithActual(content: string, actualString: string): number[] {
    if (actualString.length === 0) return [];
    const matches: number[] = [];
    let index = content.indexOf(actualString);
    while (index !== -1) {
      matches.push(index);
      index = content.indexOf(actualString, index + actualString.length);
    }
    return matches;
  }

  function applyReplacements(
    content: string,
    matches: number[],
    actualString: string,
    newString: string,
    replaceAll: boolean,
  ): string {
    if (matches.length === 0) return content;

    const indices = replaceAll ? matches : [matches[0]];

    let result = content;
    for (let i = indices.length - 1; i >= 0; i--) {
      const start = indices[i];
      result = result.slice(0, start) + newString + result.slice(start + actualString.length);
    }
    return result;
  }

  function formatEditSuccessResult(
    filePath: string,
    newContent: string,
    oldContent: string,
    oldString: string,
    newString: string,
  ): Pick<ToolResult, 'llmContent' | 'metadata'> {
    const lineCount = newContent.split('\n').length;
    const fileName = basename(filePath);
    const diffSnippet = generateDiffSnippetWithMatch(
      oldContent, newContent, oldString, newString,
    );

    const metadata: ToolResultMetadata = {
      file_path: filePath,
      file_name: fileName,
      lines_written: lineCount,
      has_diff: !!diffSnippet,
      summary: newString.length === 0
        ? `Deleted text in ${fileName}`
        : `Replaced text in ${fileName}`,
      kind: 'edit',
      oldContent: oldString,
      newContent: newString,
    };

    let llmContent: Record<string, unknown> = {
      file_path: filePath,
      line_count: lineCount,
      success: true,
    };

    if (diffSnippet) {
      llmContent = { ...llmContent, diff_snippet: diffSnippet };
    }

    return { llmContent, metadata };
  }

  function findFuzzyMatches(
    fileContent: string,
    searchString: string,
    maxResults = 3,
  ): Array<{ text: string; lineNumber: number; similarity: number }> {
    const lines = fileContent.split('\n');
    const searchLines = searchString.split('\n');

    if (searchLines.length === 1) {
      return lines
        .map((line, idx) => ({
          text: line,
          lineNumber: idx + 1,
          similarity: calculateSimilarity(searchString.trim(), line.trim()),
        }))
        .filter((m) => m.similarity > 0.5)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, maxResults);
    }

    const windowSize = searchLines.length;
    const matches: Array<{ text: string; lineNumber: number; similarity: number }> = [];
    for (let i = 0; i <= lines.length - windowSize; i++) {
      const window = lines.slice(i, i + windowSize).join('\n');
      const similarity = calculateSimilarity(searchString, window);
      if (similarity > 0.5) {
        matches.push({ text: window, lineNumber: i + 1, similarity });
      }
    }
    return matches.sort((a, b) => b.similarity - a.similarity).slice(0, maxResults);
  }

  function calculateSimilarity(str1: string, str2: string): number {
    const normalize = (s: string) =>
      s.trim().replace(/\s+/g, ' ').replace(/[\u201c\u201d"]/g, '"').replace(/[\u2018\u2019']/g, "'");

    const s1 = normalize(str1);
    const s2 = normalize(str2);
    if (s1 === s2) return 1.0;
    if (s1.length === 0) return s2.length === 0 ? 1.0 : 0.0;
    if (s2.length === 0) return 0.0;

    const maxLen = 200;
    const substr1 = s1.substring(0, maxLen);
    const substr2 = s2.substring(0, maxLen);
    const distance = levenshteinDistance(substr1, substr2);
    const maxLength = Math.max(substr1.length, substr2.length);
    return 1 - distance / maxLength;
  }

  function levenshteinDistance(str1: string, str2: string): number {
    const len1 = str1.length;
    const len2 = str2.length;

    const matrix: number[][] = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(0));
    for (let i = 0; i <= len1; i++) matrix[i][0] = i;
    for (let j = 0; j <= len2; j++) matrix[0][j] = j;

    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
      }
    }
    return matrix[len1][len2];
  }

  function formatEditNotFoundSuggestions(
    filePath: string,
    fileContent: string,
    searchString: string,
  ): { llmContent: string; metadata: Record<string, unknown> } {
    const totalLines = fileContent.split('\n').length;
    const fuzzyMatches = findFuzzyMatches(fileContent, searchString);
    const bestMatch = fuzzyMatches[0];

    let excerptStartLine = Math.max(0, (bestMatch?.lineNumber ?? 1) - 10);
    let excerptEndLine = Math.min(totalLines, (bestMatch?.lineNumber ?? 1) + 10);

    if (!bestMatch) {
      const searchFirstLine = searchString.split('\n')[0] ?? '';
      const roughLine = fileContent.split('\n').findIndex(
        (l: string) => l.trim().includes(searchFirstLine.trim().substring(0, 20)),
      );
      if (roughLine >= 0) {
        excerptStartLine = Math.max(0, roughLine - 10);
        excerptEndLine = Math.min(totalLines, roughLine + 10);
      }
    }

    const excerpt = fileContent.split('\n').slice(excerptStartLine, excerptEndLine)
      .map((line: string, idx: number) => `${excerptStartLine + idx + 1}: ${line}`)
      .join('\n');

    let suggestions = '';
    if (fuzzyMatches.length > 0) {
      suggestions = '\n\nSimilar text found:\n';
      for (const match of fuzzyMatches) {
        suggestions += `  Line ${match.lineNumber}: ${match.text.substring(0, 120)}`;
        if (match.similarity < 1) suggestions += ` (${Math.round(match.similarity * 100)}% match)`;
        suggestions += '\n';
      }
    }

    const llmContent = `The string to replace was not found in the file (even after relaxing whitespace). If you are unsure of the exact string to replace or the current file contents, read the file and try again.${suggestions}\n\nTips:\n1. Read the file to ensure you have the latest contents\n2. Check for typos, whitespace differences, or quote mismatches\n3. Provide more surrounding context to make the match unique\n4. If the code structure is different than expected, consider using the Write tool instead\n\nCommon issues:\n- Line breaks: Ensure \\n characters match exactly\n- Indentation: Spaces vs tabs mismatch\n- Smart quotes: \" \" vs \" (use straight quotes)\n- Outdated mental model: File may have changed since you last read it`;

    const metadata: Record<string, unknown> = {
      searchStringLength: searchString.length,
      fuzzyMatches: fuzzyMatches.map((m) => ({
        line: m.lineNumber,
        similarity: m.similarity,
        preview: m.text.substring(0, 100),
      })),
      excerptRange: [excerptStartLine + 1, excerptEndLine],
      totalLines,
    };

    return { llmContent, metadata };
  }

  return createTool({
    name: 'Edit',
    displayName: 'File Edit',
    kind: ToolKind.Write,
    isReadOnly: false,
    isConcurrencySafe: false,
    schema: editSchema,
    description: {
      short: 'Performs exact string replacements in files',
      long: 'Performs exact string replacements in files.',
      usageNotes: [
        'You must use your Read tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.',
        'When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix.',
        'ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.',
        'Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.',
        'The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.',
        'Use replace_all for replacing and renaming strings across the file.',
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
    validateInput: ({ old_string, new_string }, context) => {
      const filesystemRoots = context.contextSnapshot?.filesystemRoots;
      if (!filesystemRoots || filesystemRoots.length === 0) {
        return {
          message: 'No filesystem access in current context',
          llmContent: 'No filesystem access in the current runtime context.',
          errorType: ToolErrorType.PERMISSION_DENIED,
        };
      }
      if (old_string === new_string) {
        return {
          message: 'New string is identical to old string',
          llmContent: 'New string is identical; no replacement needed',
        };
      }
      return undefined;
    },
    async execute(params, context: ExecutionContext): Promise<ToolResult> {
      const { file_path: filePath, old_string: oldString, new_string: newString, replace_all: replaceAll = false } = params;
      const signal = context.signal ?? new AbortController().signal;

      try {
        await context.updateOutput?.('Starting file edit...');

        if (!(await fileSystem.exists(filePath))) {
          return {
            success: false,
            llmContent: `File not found: ${filePath}`,
            error: { type: ToolErrorType.EXECUTION_ERROR, message: `File not found: ${filePath}` },
          };
        }

        const stats = await fileSystem.stat(filePath);
        if (stats?.isDirectory) {
          return {
            success: false,
            llmContent: `Cannot edit directory: ${filePath}`,
            error: { type: ToolErrorType.EXECUTION_ERROR, message: 'Target is a directory, not a file' },
          };
        }

        if (context.sessionId && !fileAccessTracker.hasFileBeenRead(filePath)) {
          return {
            success: false,
            llmContent: `Must read file "${filePath}" before editing. Use the Read tool first.`,
            error: { type: ToolErrorType.PERMISSION_DENIED, message: `File not read: ${filePath}` },
          };
        }

        const oldContent = await fileSystem.readTextFile(filePath);
        signal.throwIfAborted();

        const matchResult = smartMatch(oldContent, oldString);
        if (!matchResult.matched) {
          try {
            const unescapedMatch = smartMatch(oldContent, unescapeString(oldString));
            if (unescapedMatch.matched) {
              return {
                success: false,
                llmContent: `Found the escaped version of the provided string. Try editing with the unescaped version:\n\n${JSON.stringify(unescapeString(oldString))}`,
                error: { type: ToolErrorType.EXECUTION_ERROR, message: 'Use unescaped string for edit' },
                metadata: { suggestion: unescapeString(oldString) },
              };
            }
          } catch {
            // Proceed with not-found suggestions
          }

          const { llmContent, metadata } = formatEditNotFoundSuggestions(filePath, oldContent, oldString);
          return { success: false, llmContent, metadata, error: { type: ToolErrorType.EXECUTION_ERROR, message: 'String not found in file' } };
        }

        const actualString = matchResult.matched;
        const allMatches = findMatchesWithActual(oldContent, actualString);

        if (allMatches.length > 1 && !replaceAll) {
          return {
            success: false,
            llmContent: `Found ${allMatches.length} matches for the given string. Use replace_all if you want to replace all instances, or provide more context to make the match unique.`,
            error: { type: ToolErrorType.EXECUTION_ERROR, message: 'Multiple matches found' },
          };
        }

        if (replaceAll && allMatches.length === 0) {
          return { success: false, llmContent: 'No matches found for replace_all', error: { type: ToolErrorType.EXECUTION_ERROR, message: 'No matches found' } };
        }

        const newContent = applyReplacements(oldContent, allMatches, actualString, newString, replaceAll);

        await fileSystem.writeTextFile(filePath, newContent);
        signal.throwIfAborted();

        const snapshotManager = context.sessionId ? snapshotManagerProvider(context.sessionId) : undefined;
        if (snapshotManager && context.messageId) {
          try { await snapshotManager.createSnapshot(filePath, context.messageId); } catch { /* best-effort */ }
        }

        if (context.sessionId) {
          try { await fileAccessTracker.recordFileEdit(filePath, context.sessionId, 'edit'); } catch { /* best-effort */ }
        }

        const { llmContent, metadata } = formatEditSuccessResult(filePath, newContent, oldContent, oldString, newString);
        return { success: true, llmContent, metadata };
      } catch (error) {
        if (signal.aborted || getErrorName(error) === 'AbortError') {
          return {
            success: false,
            llmContent: 'File edit aborted',
            error: { type: ToolErrorType.EXECUTION_ERROR, message: 'Operation aborted' },
          };
        }
        return {
          success: false,
          llmContent: `File edit failed: ${getErrorMessage(error)}`,
          error: { type: ToolErrorType.EXECUTION_ERROR, message: getErrorMessage(error), details: error },
        };
      }
    },
    version: '3.0.0',
    category: 'file',
    tags: ['file', 'io', 'edit', 'modify'],
    preparePermissionMatcher: (params) => {
      const ext = extname(params.file_path);
      return { signatureContent: params.file_path, abstractRule: ext ? `**/*${ext}` : '**/*' };
    },
  });
}

export const editTool = createEditTool();
