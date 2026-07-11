/**
 * Edit Corrector - strategies to fix common LLM edit-tool mistakes.
 *
 * Handles over-escaped characters, indentation mismatches,
 * and quote-type differences in search/replace strings.
 */

/**
 * Matching strategy used for edit corrections.
 */
export enum MatchStrategy {
  EXACT = 'exact',
  NORMALIZE_QUOTES = 'normalize_quotes',
  UNESCAPE = 'unescape',
  FLEXIBLE = 'flexible',
  FAILED = 'failed',
}

/**
 * Result of a match attempt.
 */
export interface MatchResult {
  matched: string | null;
  strategy: MatchStrategy;
}

/**
 * Un-escape an over-escaped string (common LLM mistake for newlines, quotes).
 *
 * @example
 *   unescapeString('line1\\nline2')  // → 'line1\nline2'
 *   unescapeString('say \\"hello\\"') // → 'say "hello"'
 */
export function unescapeString(input: string): string {
  return input.replace(/\\+(n|t|r|'|"|`|\\|\n)/g, (match, capturedChar: string) => {
    switch (capturedChar) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case "'":
        return "'";
      case '"':
        return '"';
      case '`':
        return '`';
      case '\\':
        return '\\';
      case '\n':
        return '\n';
      default:
        return match;
    }
  });
}

/**
 * Flexible indentation match — finds a block in `content` whose deindented
 * lines match a search string, ignoring indentation differences.
 *
 * Returns the matching text in its original indentation, or null.
 */
export function flexibleMatch(content: string, searchString: string): string | null {
  const searchLines = searchString.split('\n');

  // Single-line strings cannot be matched with flexible indentation
  if (searchLines.length === 1) return null;

  const firstLine = searchLines[0];
  const indentMatch = firstLine.match(/^(\s+)/);
  if (!indentMatch) return null;

  const searchIndent = indentMatch[1];
  const deindentedSearchLines = searchLines.map((line) =>
    line.startsWith(searchIndent) ? line.slice(searchIndent.length) : line,
  );
  const deindentedSearch = deindentedSearchLines.join('\n');

  const contentLines = content.split('\n');

  for (let i = 0; i <= contentLines.length - searchLines.length; i++) {
    const lineIndentMatch = contentLines[i].match(/^(\s+)/);
    const fileIndent = lineIndentMatch ? lineIndentMatch[1] : '';

    const snippet = contentLines.slice(i, i + searchLines.length);
    const deindentedSnippet = snippet.map((line) =>
      line.startsWith(fileIndent) ? line.slice(fileIndent.length) : line,
    );

    if (deindentedSnippet.join('\n') === deindentedSearch) {
      return snippet.join('\n');
    }
  }

  return null;
}
