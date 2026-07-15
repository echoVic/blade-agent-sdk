/**
 * BashClassifier - Classifies bash commands by danger level
 *
 * Categories:
 * - destructive: irreversible operations (rm, format, drop, etc.)
 * - write: modifies state but potentially reversible (mv, cp, chmod, etc.)
 * - readonly: read-only operations (ls, cat, grep, etc.)
 */

export type BashCommandCategory = 'destructive' | 'write' | 'readonly';

export interface BashClassification {
  category: BashCommandCategory;
  reason: string;
  matchedPattern?: string;
}

/** Patterns that indicate destructive (irreversible) operations */
const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-z]*f[a-z]*|-[a-z]*r[a-z]*f[a-z]*|--force|--recursive)/i, reason: 'force/recursive remove' },
  { pattern: /\brm\b/, reason: 'file removal' },
  { pattern: /\brmdir\b/, reason: 'directory removal' },
  { pattern: /\bshred\b/, reason: 'secure file deletion' },
  { pattern: /\bdd\b.*\bof=/, reason: 'disk write (dd)' },
  { pattern: /\bmkfs\b/, reason: 'filesystem format' },
  { pattern: /\bfdisk\b/, reason: 'disk partition' },
  { pattern: /\bformat\b/, reason: 'disk format' },
  { pattern: /\bdrop\s+(table|database|schema)/i, reason: 'database drop' },
  { pattern: /\btruncate\b/, reason: 'file/table truncation' },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: 'hard git reset' },
  { pattern: /\bgit\s+push\s+.*--force\b/, reason: 'force git push' },
  { pattern: /\bgit\s+push\s+.*-f\b/, reason: 'force git push' },
  { pattern: /\bgit\s+clean\s+-[a-z]*f/, reason: 'git clean force' },
  { pattern: /\bgit\s+branch\s+-D\b/, reason: 'force branch delete' },
  { pattern: /\bkill\s+-9\b/, reason: 'force kill process' },
  { pattern: /\bpkill\b/, reason: 'kill processes by name' },
  { pattern: /\bnpm\s+publish\b/, reason: 'publish to npm registry' },
  { pattern: /\bcurl\b.*\|\s*(bash|sh|zsh)\b/, reason: 'pipe URL to shell' },
  { pattern: /\bwget\b.*\|\s*(bash|sh|zsh)\b/, reason: 'pipe URL to shell' },
  { pattern: />\s*\/dev\/[a-z]+[0-9]/, reason: 'write to block device' },
];

/** Patterns that indicate write operations (modifies state) */
const WRITE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bmv\b/, reason: 'move/rename file' },
  { pattern: /\bcp\b/, reason: 'copy file' },
  { pattern: /\bmkdir\b/, reason: 'create directory' },
  { pattern: /\btouch\b/, reason: 'create/update file' },
  { pattern: /\bchmod\b/, reason: 'change permissions' },
  { pattern: /\bchown\b/, reason: 'change ownership' },
  { pattern: /\bln\b/, reason: 'create link' },
  { pattern: /\bnpm\s+(install|uninstall|update|ci)\b/, reason: 'npm package management' },
  { pattern: /\bpnpm\s+(install|uninstall|update|add|remove)\b/, reason: 'pnpm package management' },
  { pattern: /\byarn\s+(install|add|remove|upgrade)\b/, reason: 'yarn package management' },
  { pattern: /\bgit\s+(commit|add|checkout|merge|rebase|stash|tag)\b/, reason: 'git write operation' },
  { pattern: /\bgit\s+push\b/, reason: 'git push' },
  { pattern: /\bsudo\b/, reason: 'elevated privileges' },
  { pattern: /\bsystemctl\s+(start|stop|restart|enable|disable)\b/, reason: 'service management' },
  { pattern: /\bapt(-get)?\s+(install|remove|purge)\b/, reason: 'package installation' },
  { pattern: /\bbrew\s+(install|uninstall|upgrade)\b/, reason: 'homebrew package management' },
  { pattern: /\bpip\s+(install|uninstall)\b/, reason: 'pip package management' },
  { pattern: /\bssh\b/, reason: 'remote connection' },
  { pattern: /\bscp\b/, reason: 'secure copy' },
  { pattern: /\brsync\b/, reason: 'file sync' },
  { pattern: /\bcurl\b.*(-X\s*(POST|PUT|PATCH|DELETE)|--data|--upload-file)/, reason: 'HTTP write request' },
  { pattern: /\bwget\b.*(-O|--output-document)/, reason: 'download to file' },
  { pattern: /\btee\b/, reason: 'write to file via tee' },
  { pattern: />>/, reason: 'append redirect' },
  { pattern: /(?<![>])>(?![>])/, reason: 'output redirect' },
];

export const BashClassifier = {
  /**
   * Classify a bash command by its danger level.
   * Returns the most severe category found.
   */
  classify(command: string): BashClassification {
    // Check destructive first (highest severity)
    for (const { pattern, reason } of DESTRUCTIVE_PATTERNS) {
      if (pattern.test(command)) {
        return { category: 'destructive', reason, matchedPattern: pattern.source };
      }
    }

    // Check write operations
    for (const { pattern, reason } of WRITE_PATTERNS) {
      if (pattern.test(command)) {
        return { category: 'write', reason, matchedPattern: pattern.source };
      }
    }

    return { category: 'readonly', reason: 'no write/destructive patterns detected' };
  },

  isDestructive(command: string): boolean {
    return BashClassifier.classify(command).category === 'destructive';
  },

  isReadOnly(command: string): boolean {
    return BashClassifier.classify(command).category === 'readonly';
  },
};
