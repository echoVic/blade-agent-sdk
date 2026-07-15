import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createTool, ToolErrorType, ToolKind } from '../../tools/index.js';
import type { ExecutionContext, ToolResult } from '../../tools/types/index.js';
import { BackgroundShellManager } from './BackgroundShellManager.js';
import { OutputTruncator } from './OutputTruncator.js';

// ============================================================================
// 本地类型定义（替代 root 依赖）
// ============================================================================

interface BashClassifierPort {
  classify(command: string): { category: string; reason: string; matchedPattern?: string };
}

interface SandboxServicePort {
  getSandbox(): { enabled: boolean; image?: string; options?: Record<string, unknown> } | null;
}

interface BashBackgroundMetadata {
  command: string;
  background: true;
  pid: number;
  bash_id: string;
  shell_id: string;
  message?: string;
  summary?: string;
  [key: string]: unknown;
}

interface BashForegroundMetadata {
  command: string;
  background?: false;
  execution_time: number;
  exit_code: number | null;
  signal?: string | null;
  stdout_length?: number;
  stderr_length?: number;
  has_stderr?: boolean;
  summary?: string;
  [key: string]: unknown;
}

// ============================================================================
// 模块级可注入依赖（resolveBehavior / preparePermissionMatcher 无法访问 context）
// ============================================================================

let _bashClassifier: BashClassifierPort = {
  classify() {
    return { category: 'unknown', reason: 'No classifier configured' };
  },
};

export function setBashClassifier(classifier: BashClassifierPort): void {
  _bashClassifier = classifier;
}

// ============================================================================
// 内联工具函数（替代 errorUtils）
// ============================================================================

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

function getErrorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return 'UnknownError';
}

// ============================================================================
// Bash Tool
// ============================================================================

/**
 * Bash Tool - Shell command executor
 *
 * 设计理念：
 * - 每次命令独立执行（非持久会话）
 * - 工作目录通过 cwd 参数临时设置，或通过 `cd && command` 命令链持久改变
 * - 环境变量通过 env 参数临时设置，或通过 `export` 命令持久改变
 * - 后台进程使用唯一 ID 管理
 */
export const bashTool = createTool({
  name: 'Bash',
  displayName: 'Bash Command',
  kind: ToolKind.Execute,
  maxResultSizeChars: 200_000,

  // Zod Schema 定义
  schema: z.object({
    command: z.string().min(1).describe('Bash command to execute'),
    timeout: z
      .number()
      .int()
      .min(1000)
      .max(300000)
      .default(30000)
      .describe('Timeout in milliseconds (default 30000ms)'),
    cwd: z
      .string()
      .optional()
      .describe(
        'Working directory (optional; applies only to this command). To persist, use cd'
      ),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe('Environment variables (key-value)'),
    run_in_background: z
      .boolean()
      .default(false)
      .describe('Run in background (suitable for long-running commands)'),
  }),

  // 工具描述
  description: {
    short: 'Execute bash commands in a persistent shell session with optional timeout',
    long: `Executes bash commands with proper handling and security measures.

IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

Before executing commands:

1. Directory Verification:
   - If the command will create new directories or files, first use 'ls' to verify the parent directory exists and is the correct location
   - For example, before running "mkdir foo/bar", first use 'ls foo' to check that "foo" exists and is the intended parent directory

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g., cd "path with spaces/file.txt")
   - Examples of proper quoting:
     * cd "/Users/name/My Documents" (correct)
     * cd /Users/name/My Documents (incorrect - will fail)
     * python "/path/with spaces/script.py" (correct)
     * python /path/with spaces/script.py (incorrect - will fail)`,
    usageNotes: [
      'The command argument is required',
      'You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). If not specified, commands will timeout after 30000ms (30 seconds)',
      'It is very helpful if you write a clear, concise description of what this command does in 5-10 words',
      'If the output exceeds 30000 characters, output will be truncated before being returned to you',
      'You can use the run_in_background parameter to run the command in the background, which allows you to continue working while the command runs. You can monitor the output using the TaskOutput tool. You do not need to use "&" at the end of the command when using this parameter',
      'Avoid using Bash with the find, grep, cat, head, tail, sed, awk, or echo commands, unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands',
    ],
    examples: [
      {
        description: 'Run a simple command',
        params: {
          command: 'ls -la',
          description: 'List files in current directory',
        },
      },
      {
        description: 'Run a command with a specific timeout',
        params: {
          command: 'npm install',
          timeout: 60000,
          description: 'Install npm dependencies',
        },
      },
      {
        description: 'Run a long-running command in background',
        params: {
          command: 'npm run dev',
          run_in_background: true,
          description: 'Start development server in background',
        },
      },
      {
        description: 'Run multiple independent commands in parallel',
        params: { command: 'git status', description: 'Show working tree status' },
      },
    ],
    important: [
      'Committing changes with git:',
      '  - Only create commits when requested by the user. If unclear, ask first',
      '  - Git Safety Protocol:',
      '    * NEVER update the git config',
      '    * NEVER run destructive/irreversible git commands (like push --force, hard reset, etc) unless the user explicitly requests them',
      '    * NEVER skip hooks (--no-verify, --no-gpg-sign, etc) unless the user explicitly requests it',
      '    * NEVER run force push to main/master, warn the user if they request it',
      '    * Avoid git commit --amend. ONLY use --amend when either (1) user explicitly requested amend OR (2) adding edits from pre-commit hook',
      '    * Before amending: ALWAYS check authorship (git log -1 --format="%an %ae")',
      '    * NEVER commit changes unless the user explicitly asks you to',
      '  - When creating commits:',
      '    1. Run git status, git diff, and git log in parallel to understand changes',
      '    2. Analyze staged changes and draft a concise commit message (1-2 sentences) focusing on "why" rather than "what"',
      '    3. Add relevant untracked files, create the commit, and run git status to verify',
      '    4. Always pass commit message via HEREDOC format',
      '  - DO NOT push to remote repository unless explicitly requested',
      '  - NEVER use git commands with the -i flag (no interactive input supported)',
      '  - If no changes to commit, do not create an empty commit',
      'Creating pull requests:',
      '  - Use the gh command for ALL GitHub-related tasks',
      '  - When creating a PR:',
      '    1. Run git status, git diff, and git log in parallel to understand branch changes',
      '    2. Analyze all commits (not just the latest) and draft a PR summary',
      '    3. Create new branch if needed, push with -u flag, and create PR using gh pr create with HEREDOC body format',
      '  - Return the PR URL when done',
      'Other important notes:',
      '  - Dangerous commands (rm -rf, sudo, etc.) require user confirmation',
      '  - Background commands require manual termination using KillShell',
      '  - NEVER use find, grep, cat, sed, etc. — use dedicated tools instead',
    ],
  },

  describe: ({ command, cwd, run_in_background } = {}) => {
    const commandPreview = command?.trim()
      ? command.trim().replace(/\s+/g, ' ').slice(0, 80)
      : 'bash command';
    const modeLabel = run_in_background ? 'Run background bash command' : 'Run bash command';
    const cwdSuffix = cwd ? ` in ${cwd}` : '';

    return {
      short: `${modeLabel}: ${commandPreview}${cwdSuffix}`,
    };
  },

  resolveBehavior: ({ command, run_in_background = false }) => {
    const classification = _bashClassifier.classify(command.trim());

    if (run_in_background) {
      return {
        kind: ToolKind.Execute,
        isReadOnly: false,
        isConcurrencySafe: false,
        isDestructive: classification.category === 'destructive',
      };
    }

    if (classification.category === 'readonly') {
      return {
        kind: ToolKind.ReadOnly,
        isReadOnly: true,
        isConcurrencySafe: true,
        isDestructive: false,
      };
    }

    return {
      kind: ToolKind.Execute,
      isReadOnly: false,
      isConcurrencySafe: false,
      isDestructive: classification.category === 'destructive',
    };
  },

  validateInput: ({ cwd }, context) => {
    const workDir = cwd || context.contextSnapshot?.cwd;
    if (workDir) {
      return undefined;
    }

    return {
      message: 'No working directory available',
      llmContent:
        'No working directory provided and no filesystem working directory is available.',
    };
  },

  checkPermissions: ({ command }, context) => {
    const sandboxService = (context as Record<string, unknown>).sandboxService as SandboxServicePort | undefined;
    if (!sandboxService) {
      return undefined;
    }

    const sandboxCheck = sandboxService.getSandbox();
    if (!sandboxCheck) {
      return undefined;
    }

    // Sandbox check is a simplified pass-through when no full sandbox service is available
    return undefined;
  },

  // 执行函数
  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { command, timeout = 30000, cwd, env, run_in_background = false } = params;
    const { updateOutput } = context;
    const signal = context.signal ?? new AbortController().signal;

    try {
      const sandboxService = (context as Record<string, unknown>).sandboxService as SandboxServicePort | undefined;
      const workDir = cwd || context.contextSnapshot?.cwd;
      if (!workDir) {
        throw new Error('validateInput should guarantee a working directory');
      }

      const effectiveCommand = sandboxService
        ? (sandboxService as unknown as { wrapCommandForSandbox?: (cmd: string, dir: string) => string }).wrapCommandForSandbox?.(command, workDir) ?? command
        : command;

      if (sandboxService && (sandboxService as unknown as { isEnabled?: () => boolean }).isEnabled?.() && effectiveCommand !== command) {
        updateOutput?.(`🔒 Executing in sandbox: ${command}`);
      } else {
        updateOutput?.(`Executing Bash command: ${command}`);
      }

      if (run_in_background) {
        return executeInBackground(effectiveCommand, workDir, env);
      }

      return executeWithTimeout(effectiveCommand, workDir, env, timeout, signal, updateOutput);
    } catch (error: unknown) {
      if (getErrorName(error) === 'AbortError') {
        return {
          success: false,
          llmContent: 'Command execution aborted',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: 'Operation aborted',
          },
        };
      }

      return {
        success: false,
        llmContent: `Command execution failed: ${getErrorMessage(error)}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: getErrorMessage(error),
          details: error,
        },
      };
    }
  },

  version: '2.0.0',
  category: '命令工具',
  tags: ['bash', 'shell', 'non-interactive', 'event-driven'],

  preparePermissionMatcher: (params) => {
    const command = params.command.trim();
    const classification = _bashClassifier.classify(command);
    const parts = command.split(/\s+/);
    const signatureContent = command;

    if (parts.length === 1) {
      return {
        signatureContent,
        abstractRule: `${classification.category}:${parts[0]}`,
      };
    }

    const runLikeSubcommands = ['run', 'exec', 'test', 'start', 'build', 'dev'];
    if (runLikeSubcommands.includes(parts[1])) {
      if (parts.length === 2) {
        return {
          signatureContent,
          abstractRule: `${classification.category}:${parts[0]} ${parts[1]}`,
        };
      }
      return {
        signatureContent,
        abstractRule: `${classification.category}:${parts[0]} ${parts[1]} *`,
      };
    }

    if (parts.length === 2) {
      return {
        signatureContent,
        abstractRule: `${classification.category}:${parts[0]} ${parts[1]}`,
      };
    }

    return {
      signatureContent,
      abstractRule: `${classification.category}:${parts[0]} ${parts[1]} *`,
    };
  },
});

// ============================================================================
// 后台执行命令
// ============================================================================

function executeInBackground(
  command: string,
  cwd: string,
  env?: Record<string, string>
): ToolResult {
  const manager = BackgroundShellManager.getInstance();
  const backgroundProcess = manager.startBackgroundProcess({
    command,
    sessionId: randomUUID(),
    cwd,
    env: env ?? undefined,
  });

  const cmdPreview = command.length > 30 ? `${command.substring(0, 30)}...` : command;
  const summary = `后台启动命令: ${cmdPreview}`;

  const metadata: BashBackgroundMetadata = {
    command,
    background: true,
    pid: backgroundProcess.pid ?? 0,
    bash_id: backgroundProcess.id,
    shell_id: backgroundProcess.id,
    message: '命令已在后台启动',
    summary,
  };

  return {
    success: true,
    llmContent: {
      command,
      background: true,
      pid: backgroundProcess.pid,
      bash_id: backgroundProcess.id,
      shell_id: backgroundProcess.id,
    },
    metadata,
  };
}

// ============================================================================
// 带超时的命令执行 - 使用进程事件监听
// ============================================================================

async function executeWithTimeout(
  command: string,
  cwd: string,
  env: Record<string, string> | undefined,
  timeout: number,
  signal: AbortSignal,
  _updateOutput?: (output: string) => void
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    // 创建进程
    const bashProcess = spawn('bash', ['-c', command], {
      cwd,
      env: { ...process.env, ...env, BLADE_CLI: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 收集 stdout
    bashProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    // 收集 stderr
    bashProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // 设置超时
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      bashProcess.kill('SIGTERM');

      // 如果 SIGTERM 无效,强制 SIGKILL
      setTimeout(() => {
        if (!bashProcess.killed) {
          bashProcess.kill('SIGKILL');
        }
      }, 1000);
    }, timeout);

    // 处理中止信号
    const abortHandler = () => {
      bashProcess.kill('SIGTERM');
      clearTimeout(timeoutHandle);
    };

    // 兼容不同版本的 AbortSignal API
    if (signal.addEventListener) {
      signal.addEventListener('abort', abortHandler);
    } else if ('onabort' in signal) {
      (signal as unknown as { onabort: () => void }).onabort = abortHandler;
    }

    // 监听进程完成事件 - 业界标准做法
    bashProcess.on('close', (code, sig) => {
      clearTimeout(timeoutHandle);
      // 移除中止监听器
      if (signal.removeEventListener) {
        signal.removeEventListener('abort', abortHandler);
      } else if ('onabort' in signal) {
        (signal as unknown as { onabort: null }).onabort = null;
      }

      const executionTime = Date.now() - startTime;

      // 如果超时
      if (timedOut) {
        resolve({
          success: false,
          llmContent: `Command execution timed out (${timeout}ms)`,
          error: {
            type: ToolErrorType.TIMEOUT_ERROR,
            message: '命令执行超时',
          },
          metadata: {
            command,
            timeout: true,
            stdout,
            stderr,
            execution_time: executionTime,
          },
        });
        return;
      }

      // 如果被中止
      if (signal.aborted) {
        resolve({
          success: false,
          llmContent: 'Command execution aborted by user',
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: '操作被中止',
          },
          metadata: {
            command,
            aborted: true,
            stdout,
            stderr,
            execution_time: executionTime,
          },
        });
        return;
      }

      // 正常完成
      // 生成 summary 用于流式显示
      const cmdPreview =
        command.length > 30 ? `${command.substring(0, 30)}...` : command;
      const summary =
        code === 0
          ? `执行命令成功 (${executionTime}ms): ${cmdPreview}`
          : `执行命令完成 (退出码 ${code}, ${executionTime}ms): ${cmdPreview}`;

      const metadata: BashForegroundMetadata = {
        command,
        execution_time: executionTime,
        exit_code: code,
        signal: sig,
        stdout_length: stdout.length,
        stderr_length: stderr.length,
        has_stderr: stderr.length > 0,
        summary,
      };

      const truncated = OutputTruncator.truncateForLLM(
        stdout.trim(),
        stderr.trim(),
        command
      );

      resolve({
        success: true,
        llmContent: {
          stdout: truncated.stdout,
          stderr: truncated.stderr,
          execution_time: executionTime,
          exit_code: code,
          signal: sig,
          ...(truncated.truncationInfo && {
            truncation_info: truncated.truncationInfo,
          }),
        },
        metadata,
      });
    });

    // 监听进程错误
    bashProcess.on('error', (error) => {
      clearTimeout(timeoutHandle);
      // 移除中止监听器
      if (signal.removeEventListener) {
        signal.removeEventListener('abort', abortHandler);
      } else if ('onabort' in signal) {
        (signal as unknown as { onabort: null }).onabort = null;
      }

      resolve({
        success: false,
        llmContent: `Command execution failed: ${error.message}`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: error.message,
          details: error,
        },
      });
    });
  });
}
