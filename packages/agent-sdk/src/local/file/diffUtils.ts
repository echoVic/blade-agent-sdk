import * as Diff from 'diff';

/**
 * Generate a unified diff snippet between two file contents.
 *
 * @param oldContent Previous file content
 * @param newContent New file content
 * @param contextLines Number of context lines (default 4)
 * @returns Diff wrapped in `<</DIFF>>>` markers, or null when contents are identical
 */
export function generateDiffSnippet(
  oldContent: string,
  newContent: string,
  contextLines = 4,
): string | null {
  if (oldContent === newContent) {
    return null;
  }

  const patch = Diff.createPatch('file', oldContent, newContent, '', '', {
    context: contextLines,
  });

  const lines = patch.split('\n');
  let matchLine = 1;
  for (const line of lines) {
    const hunkMatch = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
    if (hunkMatch) {
      matchLine = parseInt(hunkMatch[1], 10);
      break;
    }
  }

  return `\n<<<DIFF>>>\n${JSON.stringify({
    patch,
    startLine: Math.max(1, matchLine - contextLines),
    matchLine,
  })}\n<<</DIFF>>>\n`;
}

/**
 * Generate a unified diff snippet for a specific matched replacement.
 *
 * @param oldContent Previous file content
 * @param newContent New file content
 * @param oldString The string that was replaced
 * @param newString The replacement string
 * @param contextLines Number of context lines (default 4)
 * @returns Diff wrapped in `<</DIFF>>>` markers, or null when oldString is not found
 */
export function generateDiffSnippetWithMatch(
  oldContent: string,
  newContent: string,
  oldString: string,
  newString: string,
  contextLines = 4,
): string | null {
  const firstMatchIndex = oldContent.indexOf(oldString);
  if (firstMatchIndex === -1) return null;

  const beforeLines = oldContent.substring(0, firstMatchIndex).split('\n');
  const matchLine = beforeLines.length - 1;

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const oldStringLines = oldString.split('\n');
  const newStringLines = newString.split('\n');
  const startLine = Math.max(0, matchLine - contextLines);
  const oldEndLine = Math.min(
    oldLines.length,
    matchLine + oldStringLines.length + contextLines,
  );
  const newEndLine = Math.min(
    newLines.length,
    matchLine + newStringLines.length + contextLines,
  );

  const oldSnippet = oldLines.slice(startLine, oldEndLine).join('\n');
  const newSnippet = newLines.slice(startLine, newEndLine).join('\n');

  const patch = Diff.createPatch('file', oldSnippet, newSnippet, '', '', {
    context: contextLines,
  });

  return `\n<<<DIFF>>>\n${JSON.stringify({
    patch,
    startLine: startLine + 1,
    matchLine: matchLine + 1,
  })}\n<<</DIFF>>>\n`;
}
