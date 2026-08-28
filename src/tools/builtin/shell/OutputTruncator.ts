/**
 * OutputTruncator - 智能输出截断工具
 *
 * 用于处理命令输出，避免大量输出占用过多上下文窗口。
 * 采用分级策略：根据命令类型选择不同的截断规则。
 */

export interface TruncationConfig {
  maxLines: number;
  maxChars: number;
  keepHead: number;
  keepTail: number;
  summarize: boolean;
}

export interface TruncationResult {
  content: string;
  truncated: boolean;
  originalLines: number;
  originalChars: number;
  summary?: string;
}

const AGGRESSIVE_TRUNCATION: TruncationConfig = {
  maxLines: 30,
  maxChars: 3000,
  keepHead: 10,
  keepTail: 10,
  summarize: true,
};

const MODERATE_TRUNCATION: TruncationConfig = {
  maxLines: 100,
  maxChars: 10000,
  keepHead: 40,
  keepTail: 40,
  summarize: true,
};

const CONSERVATIVE_TRUNCATION: TruncationConfig = {
  maxLines: 200,
  maxChars: 20000,
  keepHead: 80,
  keepTail: 80,
  summarize: false,
};

const DEFAULT_TRUNCATION: TruncationConfig = {
  maxLines: 150,
  maxChars: 15000,
  keepHead: 50,
  keepTail: 50,
  summarize: true,
};

const COMMAND_PATTERNS: Array<{
  pattern: RegExp;
  config: TruncationConfig;
  summaryTemplate?: (lines: number, chars: number) => string;
}> = [
  {
    pattern: /^git\s+(rm|add)\s+(-r|--cached|-rf|-f)?\s*/i,
    config: AGGRESSIVE_TRUNCATION,
    summaryTemplate: (lines) => `Successfully processed ${lines} files`,
  },
  {
    pattern: /^(npm|pnpm|yarn|bun)\s+(install|i|add|remove|uninstall)/i,
    config: AGGRESSIVE_TRUNCATION,
    summaryTemplate: (lines) => `Package operation completed (${lines} lines of output)`,
  },
  {
    pattern: /^(npm|pnpm|yarn|bun)\s+(run|exec)\s+(build|compile|bundle)/i,
    config: MODERATE_TRUNCATION,
    summaryTemplate: (lines) => `Build completed (${lines} lines of output)`,
  },
  {
    pattern: /^(npm|pnpm|yarn|bun)\s+(run|exec)\s+(test|lint|check)/i,
    config: CONSERVATIVE_TRUNCATION,
  },
  {
    pattern: /^git\s+(status|branch|remote)/i,
    config: MODERATE_TRUNCATION,
  },
  {
    pattern: /^git\s+(log|diff|show)/i,
    config: CONSERVATIVE_TRUNCATION,
  },
  {
    pattern: /^(ls|dir|tree)\s+/i,
    config: MODERATE_TRUNCATION,
    summaryTemplate: (lines) => `Listed ${lines} items`,
  },
  {
    pattern: /^find\s+/i,
    config: MODERATE_TRUNCATION,
    summaryTemplate: (lines) => `Found ${lines} matches`,
  },
  {
    pattern: /^(grep|rg|ag)\s+/i,
    config: MODERATE_TRUNCATION,
    summaryTemplate: (lines) => `Found ${lines} matching lines`,
  },
  {
    pattern: /^(docker|podman)\s+(build|pull|push)/i,
    config: AGGRESSIVE_TRUNCATION,
    summaryTemplate: (lines) => `Docker operation completed (${lines} lines)`,
  },
  {
    pattern: /^(pip|pip3|poetry|pipenv)\s+(install|uninstall)/i,
    config: AGGRESSIVE_TRUNCATION,
    summaryTemplate: (lines) => `Python package operation completed (${lines} lines)`,
  },
  {
    pattern: /^(cargo|rustup)\s+(build|install|update)/i,
    config: MODERATE_TRUNCATION,
    summaryTemplate: (lines) => `Rust operation completed (${lines} lines)`,
  },
  {
    pattern: /^(go)\s+(build|get|mod)/i,
    config: MODERATE_TRUNCATION,
    summaryTemplate: (lines) => `Go operation completed (${lines} lines)`,
  },
];

function getConfigForCommand(
  command: string
): { config: TruncationConfig; summaryTemplate?: (lines: number, chars: number) => string } {
  for (const { pattern, config, summaryTemplate } of COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return { config, summaryTemplate };
    }
  }
  return { config: DEFAULT_TRUNCATION };
}

export function truncate(output: string, command: string): TruncationResult {
  const { config, summaryTemplate } = getConfigForCommand(command);
  return truncateWithConfig(output, config, summaryTemplate);
}

export function truncateWithConfig(
  output: string,
  config: TruncationConfig,
  summaryTemplate?: (lines: number, chars: number) => string
): TruncationResult {
  const originalChars = output.length;
  const lines = output.split('\n');
  const originalLines = lines.length;

  if (originalLines <= config.maxLines && originalChars <= config.maxChars) {
    return {
      content: output,
      truncated: false,
      originalLines,
      originalChars,
    };
  }

  let truncatedContent = output;
  if (originalLines > config.maxLines) {
    const maxRetainedLines = Math.min(originalLines - 1, config.maxLines);
    const desiredRetainedLines = Math.max(1, config.keepHead + config.keepTail);
    const headCount = Math.min(
      config.keepHead,
      Math.ceil((maxRetainedLines * config.keepHead) / desiredRetainedLines),
    );
    const tailCount = Math.min(config.keepTail, maxRetainedLines - headCount);
    const headLines = lines.slice(0, headCount);
    const tailLines = tailCount > 0 ? lines.slice(-tailCount) : [];
    const truncatedCount = Math.max(0, originalLines - headCount - tailCount);

    truncatedContent = headLines.join('\n');
    truncatedContent += `\n\n... (${truncatedCount} lines truncated, showing first ${headCount} and last ${tailCount} of ${originalLines} total) ...\n\n`;
    truncatedContent += tailLines.join('\n');
  }

  if (truncatedContent.length > config.maxChars) {
    const marker = `... (${originalChars} chars truncated) ...`;
    if (marker.length >= config.maxChars) {
      truncatedContent = marker.slice(0, config.maxChars);
    } else {
      const availableChars = config.maxChars - marker.length;
      const headChars = Math.ceil(availableChars / 2);
      const tailChars = Math.floor(availableChars / 2);
      truncatedContent = `${truncatedContent.slice(0, headChars)}${marker}${
        tailChars > 0 ? truncatedContent.slice(-tailChars) : ''
      }`;
    }
  }

  const summary = config.summarize && summaryTemplate
    ? summaryTemplate(originalLines, originalChars)
    : undefined;

  if (summary) {
    truncatedContent += `\n\n[Summary: ${summary}]`;
  }

  return {
    content: truncatedContent,
    truncated: true,
    originalLines,
    originalChars,
    summary,
  };
}

export function truncateForLLM(
  stdout: string,
  stderr: string,
  command: string
): { stdout: string; stderr: string; truncationInfo?: string } {
  const stdoutResult = truncate(stdout, command);
  const stderrResult = truncate(stderr, command);

  let truncationInfo: string | undefined;

  if (stdoutResult.truncated || stderrResult.truncated) {
    const parts: string[] = [];
    if (stdoutResult.truncated) {
      parts.push(
        `stdout: ${stdoutResult.originalLines} lines → ${stdoutResult.content.split('\n').length} lines`
      );
    }
    if (stderrResult.truncated) {
      parts.push(
        `stderr: ${stderrResult.originalLines} lines → ${stderrResult.content.split('\n').length} lines`
      );
    }
    truncationInfo = `Output truncated: ${parts.join(', ')}`;
  }

  return {
    stdout: stdoutResult.content,
    stderr: stderrResult.content,
    truncationInfo,
  };
}

export function shouldTruncate(output: string, command: string): boolean {
  const { config } = getConfigForCommand(command);
  const lines = output.split('\n').length;
  return lines > config.maxLines || output.length > config.maxChars;
}

export function getStats(output: string): { lines: number; chars: number; words: number } {
  return {
    lines: output.split('\n').length,
    chars: output.length,
    words: output.split(/\s+/).filter(Boolean).length,
  };
}

export const OutputTruncator = { truncate, truncateWithConfig, truncateForLLM, shouldTruncate, getStats };
