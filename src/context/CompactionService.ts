/**
 * 上下文压缩服务
 * 负责协调整个压缩流程：分析文件、生成总结、创建压缩消息
 */

import { nanoid } from 'nanoid';
import { HookManager } from '../hooks/HookManager.js';
import { NOOP_LOGGER } from '../logging/Logger.js';
import {
    createChatServiceAsync,
    type Message,
} from '../services/ChatServiceInterface.js';
import { SessionId } from '../types/branded.js';
import { PermissionMode, type ProviderType } from '../types/common.js';
import { FileAnalyzer, type FileContent } from './FileAnalyzer.js';
import {
    microcompact,
    type MicrocompactOptions,
    type MicrocompactResult,
} from './strategies/MicrocompactStrategy.js';
import { TokenCounter } from './TokenCounter.js';

/**
 * 压缩选项
 */
export interface CompactionOptions {
  /** 触发方式：自动或手动 */
  trigger: 'auto' | 'manual';
  /** 模型名称 */
  modelName: string;
  /** 上下文窗口大小（从 config.maxContextTokens 传入） */
  maxContextTokens: number;
  /** API Key（可选，默认使用环境变量） */
  apiKey?: string;
  /** Base URL（可选，默认使用环境变量） */
  baseURL?: string;
  /** Provider 类型（可选，默认从调用方透传或按 baseURL 推断） */
  provider?: ProviderType;
  /** Provider 自定义 headers（可选，压缩时沿用主对话配置） */
  customHeaders?: Record<string, string>;
  /** 真实的 preTokens（可选，来自 LLM usage，比估算更准确） */
  actualPreTokens?: number;
  /** 会话 ID（用于 hooks） */
  sessionId?: SessionId;
  /** 权限模式（用于 hooks） */
  permissionMode?: PermissionMode;
  /** 当前 turn 的项目目录（用于 hooks） */
  projectDir?: string;
}

/**
 * 压缩结果
 */
export interface CompactionResult {
  /** 是否成功 */
  success: boolean;
  /** 总结内容 */
  summary: string;
  /** 压缩前 token 数 */
  preTokens: number;
  /** 压缩后 token 数 */
  postTokens: number;
  /** 包含的文件列表 */
  filesIncluded: string[];
  /** 压缩后的消息列表（用于发送给 LLM） */
  compactedMessages: Message[];
  /** compact_boundary 消息（用于保存到 JSONL） */
  boundaryMessage: Message;
  /** summary 消息（用于保存到 JSONL） */
  summaryMessage: Message;
  /** 错误信息（如果失败） */
  error?: string;
}

/** 压缩阈值百分比（80%） */
const THRESHOLD_PERCENT = 0.8;

/** 保留比例（20%） */
const RETAIN_PERCENT = 0.2;

/** 降级时保留比例（30%） */
const FALLBACK_RETAIN_PERCENT = 0.3;

/**
 * 执行压缩
 *
 * @param messages - 消息列表
 * @param options - 压缩选项
 * @returns 压缩结果
 */
export async function compact(
  messages: Message[],
  options: CompactionOptions
): Promise<CompactionResult> {
  const preTokens =
    options.actualPreTokens ?? TokenCounter.countTokens(messages, options.modelName);
  const tokenSource = options.actualPreTokens
    ? 'actual (from LLM usage)'
    : 'estimated';
  console.log(`[CompactionService] preTokens source: ${tokenSource}`);

  if (options.projectDir) {
    try {
    const hookManager = HookManager.getInstance();

    const preCompactResult = await hookManager.executePreCompactHooks(
      {
        trigger: options.trigger,
        messages_before: messages.length,
        tokens_before: preTokens,
      },
      options.projectDir,
      options.sessionId || SessionId('unknown'),
      options.permissionMode || PermissionMode.DEFAULT,
    );

    if (preCompactResult.blockCompaction) {
      console.log(
        `[CompactionService] PreCompact hook 阻止压缩: ${preCompactResult.blockReason || '(无原因)'}`
      );
      return {
        success: false,
        summary: '',
        preTokens,
        postTokens: preTokens,
        filesIncluded: [],
        compactedMessages: messages,
        boundaryMessage: { role: 'system', content: '' },
        summaryMessage: { role: 'user', content: '' },
        error: preCompactResult.blockReason || 'Compaction blocked by PreCompact hook',
      };
    }
    if (preCompactResult.warning) {
      console.warn(`[CompactionService] PreCompact hook warning: ${preCompactResult.warning}`);
    }

    const hookResult = await hookManager.executeCompactionHooks(options.trigger, {
      projectDir: options.projectDir,
      sessionId: options.sessionId || SessionId('unknown'),
      permissionMode: options.permissionMode || PermissionMode.DEFAULT,
      messagesBefore: messages.length,
      tokensBefore: preTokens,
    });

    if (hookResult.blockCompaction) {
      console.log(
        `[CompactionService] Compaction hook 阻止压缩: ${hookResult.blockReason || '(无原因)'}`
      );
      return {
        success: false,
        summary: '',
        preTokens,
        postTokens: preTokens,
        filesIncluded: [],
        compactedMessages: messages,
        boundaryMessage: { role: 'system', content: '' },
        summaryMessage: { role: 'user', content: '' },
        error: hookResult.blockReason || 'Compaction blocked by hook',
      };
    }

    if (hookResult.warning) {
      console.warn(
        `[CompactionService] Compaction hook warning: ${hookResult.warning}`
      );
    }
    } catch (hookError) {
      console.warn('[CompactionService] Compaction hook execution failed:', hookError);
    }
  }

  try {
    console.log('[CompactionService] 开始压缩，消息数:', messages.length);
    console.log('[CompactionService] 压缩前 tokens:', preTokens);

    const fileRefs = FileAnalyzer.analyzeFiles(messages);
    const filePaths = fileRefs.map((f) => f.path);
    console.log('[CompactionService] 提取重点文件:', filePaths);

    const fileContents = await FileAnalyzer.readFilesContent(filePaths);
    console.log('[CompactionService] 成功读取文件:', fileContents.length);

    const summary = await generateSummary(messages, fileContents, options);
    console.log('[CompactionService] 生成总结，长度:', summary.length);

    const retainCount = Math.ceil(messages.length * RETAIN_PERCENT);
    const candidateMessages = messages.slice(-retainCount);

    const availableToolCallIds = new Set<string>();
    for (const msg of candidateMessages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          availableToolCallIds.add(tc.id);
        }
      }
    }

    const retainedMessages = candidateMessages.filter((msg) => {
      if (msg.role === 'tool' && msg.tool_call_id) {
        return availableToolCallIds.has(msg.tool_call_id);
      }
      return true;
    });

    console.log('[CompactionService] 保留消息数:', retainCount);
    console.log('[CompactionService] 过滤后保留消息数:', retainedMessages.length);

    const boundaryMessageId = nanoid();
    const boundaryMessage = createBoundaryMessage(
      boundaryMessageId,
      options.trigger,
      preTokens
    );

    const summaryMessageId = nanoid();
    const summaryMessage = createSummaryMessage(summaryMessageId, summary);

    const compactedMessages = [summaryMessage, ...retainedMessages];
    const postTokens = TokenCounter.countTokens(compactedMessages, options.modelName);

    console.log('[CompactionService] 压缩完成！');
    console.log(
      '[CompactionService] Token 变化:',
      preTokens,
      '→',
      postTokens,
      `(-${((1 - postTokens / preTokens) * 100).toFixed(1)}%)`
    );

    if (options.projectDir) {
      try {
        const postHookManager = HookManager.getInstance();
        const postHookResult = await postHookManager.executePostCompactHooks(
          {
            trigger: options.trigger,
            messages_before: messages.length,
            messages_after: compactedMessages.length,
            tokens_before: preTokens,
            tokens_after: postTokens,
            summary,
          },
          options.projectDir,
          options.sessionId || SessionId('unknown'),
          options.permissionMode || PermissionMode.DEFAULT,
        );
        if (postHookResult.warning) {
          console.warn(`[CompactionService] PostCompact hook warning: ${postHookResult.warning}`);
        }
      } catch (hookError) {
        console.warn('[CompactionService] PostCompact hook execution failed:', hookError);
      }
    }

    return {
      success: true,
      summary,
      preTokens,
      postTokens,
      filesIncluded: filePaths,
      compactedMessages,
      boundaryMessage,
      summaryMessage,
    };
  } catch (error) {
    console.error('[CompactionService] 压缩失败，使用降级策略', error);
    return fallbackCompact(messages, options, preTokens, error);
  }
}

export function microcompactMessages(
  messages: Message[],
  options: MicrocompactOptions = {},
): MicrocompactResult {
  return microcompact(messages, options);
}

/**
 * 生成总结（调用 LLM）
 *
 * @param messages - 消息列表
 * @param fileContents - 文件内容列表
 * @param options - 压缩选项
 * @returns 总结内容
 */
async function generateSummary(
  messages: Message[],
  fileContents: FileContent[],
  options: CompactionOptions
): Promise<string> {
  const prompt = buildCompactionPrompt(messages, fileContents);
  const baseURL =
    options.baseURL || process.env.BLADE_BASE_URL || 'https://api.openai.com/v1';

  console.log('[CompactionService] 使用压缩模型:', options.modelName);

  const chatService = await createChatServiceAsync({
    apiKey: options.apiKey || process.env.BLADE_API_KEY || '',
    baseUrl: baseURL,
    model: options.modelName,
    temperature: 0.3,
    maxOutputTokens: 8000,
    timeout: 60000,
    provider: options.provider || inferProvider(baseURL),
    customHeaders: options.customHeaders,
  }, NOOP_LOGGER);

  const response = await chatService.sideQuery(
    [{ role: 'user', content: prompt }]
  );

  const content = response.content || '';
  const summaryMatch = content.match(/<summary>([\s\S]*?)<\/summary>/);

  if (!summaryMatch) {
    console.warn('[CompactionService] 总结格式不正确，使用完整响应');
    return content;
  }

  return summaryMatch[1].trim();
}

function inferProvider(baseURL?: string): ProviderType {
  if (!baseURL) {
    return 'openai';
  }

  const normalized = baseURL.toLowerCase();
  if (normalized.includes('api.openai.com')) {
    return 'openai';
  }
  if (normalized.includes('.openai.azure')) {
    return 'azure-openai';
  }
  if (normalized.includes('api.anthropic.com')) {
    return 'anthropic';
  }
  if (
    normalized.includes('generativelanguage.googleapis.com')
    || normalized.includes('aiplatform.googleapis.com')
  ) {
    return 'gemini';
  }
  return 'openai-compatible';
}

/**
 * 构建压缩 prompt
 *
 * @param messages - 消息列表
 * @param fileContents - 文件内容列表
 * @returns 压缩 prompt
 */
function buildCompactionPrompt(
  messages: Message[],
  fileContents: FileContent[]
): string {
  const messagesText = messages
    .map((msg, i) => {
      const role = msg.role || 'unknown';
      const content =
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

      const maxLength = 5000;
      const truncatedContent =
        content.length > maxLength
          ? content.substring(0, maxLength) + '...'
          : content;

      return `[${i + 1}] ${role}: ${truncatedContent}`;
    })
    .join('\n\n');

  const filesText = fileContents
    .map((file) => {
      return `### ${file.path}\n\`\`\`\n${file.content}\n\`\`\``;
    })
    .join('\n\n');

  const basePrompt = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
  - Errors that you ran into and how you fixed them
  - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request.`;

  return `${basePrompt}

## Conversation History

${messagesText}

${fileContents.length > 0 ? `## Important Files\n\n${filesText}` : ''}

Please provide your summary following the structure specified above, with both <analysis> and <summary> sections.`;
}

/**
 * 创建 compact_boundary 消息
 *
 * @param parentId - 父消息 ID
 * @param trigger - 触发方式
 * @param preTokens - 压缩前 token 数
 * @returns boundary 消息
 */
function createBoundaryMessage(
  parentId: string,
  trigger: 'auto' | 'manual',
  preTokens: number
): Message {
  return {
    id: nanoid(),
    role: 'system',
    content: 'Conversation compacted',
    metadata: {
      type: 'system',
      subtype: 'compact_boundary',
      parentId,
      compactMetadata: {
        trigger,
        preTokens,
      },
    },
  };
}

/**
 * 创建 summary 消息
 *
 * @param parentId - 父消息 ID（compact_boundary 的 ID）
 * @param summary - 总结内容
 * @returns summary 消息
 */
function createSummaryMessage(parentId: string, summary: string): Message {
  return {
    id: nanoid(),
    role: 'user',
    content: summary,
    metadata: {
      parentId,
      isCompactSummary: true,
    },
  };
}

/**
 * 降级策略：简单截断
 *
 * @param messages - 消息列表
 * @param options - 压缩选项
 * @param preTokens - 压缩前 token 数
 * @param error - 错误信息
 * @returns 压缩结果
 */
function fallbackCompact(
  messages: Message[],
  options: CompactionOptions,
  preTokens: number,
  error: unknown
): CompactionResult {
  const retainCount = Math.ceil(messages.length * FALLBACK_RETAIN_PERCENT);
  const candidateMessages = messages.slice(-retainCount);

  const availableToolCallIds = new Set<string>();
  for (const msg of candidateMessages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        availableToolCallIds.add(tc.id);
      }
    }
  }

  const retainedMessages = candidateMessages.filter((msg) => {
    if (msg.role === 'tool' && msg.tool_call_id) {
      return availableToolCallIds.has(msg.tool_call_id);
    }
    return true;
  });

  const boundaryMessageId = nanoid();
  const boundaryMessage = createBoundaryMessage(
    boundaryMessageId,
    options.trigger,
    preTokens
  );

  const errorMsg = error instanceof Error ? error.message : String(error);
  const summaryMessageId = nanoid();
  const summaryMessage = createSummaryMessage(
    summaryMessageId,
    `[Automatic compaction failed; using fallback]\n\nAn error occurred during compaction. Retained the latest ${retainCount} messages (~30%).\n\nError: ${errorMsg}\n\nThe conversation can continue, but consider retrying compaction later with /compact.`
  );

  const compactedMessages = [summaryMessage, ...retainedMessages];
  const postTokens = TokenCounter.countTokens(compactedMessages, options.modelName);

  return {
    success: false,
    summary:
      typeof summaryMessage.content === 'string'
        ? summaryMessage.content
        : summaryMessage.content
            .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
            .map((p) => p.text)
            .join('\n'),
    preTokens,
    postTokens,
    filesIncluded: [],
    compactedMessages,
    boundaryMessage,
    summaryMessage,
    error: errorMsg,
  };
}

export const CompactionService = {
  compact,
  microcompact: microcompactMessages,
};
