/**
 * Cross-platform path splitting — normalises separators and splits into
 * non-empty parts.  Pure string manipulation; no Node dependencies.
 *
 * @example
 *   splitPath('/a/b/c.txt')             // → ['a', 'b', 'c.txt']
 *   splitPath('C:\\Users\\HP\\file.txt') // → ['C:', 'Users', 'HP', 'file.txt']
 */
export function splitPath(filePath: string): string[] {
  return filePath.replace(/\\/g, '/').split('/').filter(Boolean);
}
