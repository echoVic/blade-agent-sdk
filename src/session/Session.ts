import { JSONLStore } from '@/context/storage/JSONLStore.js';
import { getSessionFilePath } from '@/context/storage/pathUtils.js';
import { nanoid } from 'nanoid';
import type { ChatCompletionMessageToolCall } from 'openai/resources/chat';
import { Agent } from '../agent/Agent.js';
import type { ChatContext, LoopOptions } from '../agent/types.js';
import { CommandRegistry } from '../commands/CommandRegistry.js';
import { createLogger, LogCategory } from '../logging/Logger.js';
import type { Message } from '../services/ChatServiceInterface.js';
import type { ToolResult } from '../tools/types/index.js';
import {
  type BladeConfig,
  type MessageRole,
  type ModelConfig,
  PermissionMode,
  type ProviderType,
} from '../types/common.js';
import type {
  ISession,
  McpServerStatus,
  ModelInfo,
  PromptResult,
  ProviderConfig,
  SendOptions,
  SessionOptions,
  SlashCommand,
  StreamMessage,
  StreamOptions,
  TokenUsage,
  ToolCallRecord
} from './types.js';

const logger = createLogger(LogCategory.AGENT);

export interface ResumeOptions extends SessionOptions {
  sessionId: string;
}

class Session implements ISession {
  readonly sessionId: string;
  private agent: Agent | null = null;
  private abortController: AbortController | null = null;
  private _messages: Message[] = [];
  private options: SessionOptions;
  private maxTurns: number;
  private permissionMode: PermissionMode;
  private initialized = false;

  private pendingMessage: string | null = null;
  private pendingSendOptions: SendOptions | null = null;

  constructor(options: SessionOptions, sessionId?: string) {
    this.sessionId = sessionId || nanoid();
    this.options = options;
    this.maxTurns = options.maxTurns ?? 200;
    this.permissionMode = options.permissionMode ?? PermissionMode.DEFAULT;
  }

  get messages(): Message[] {
    return [...this._messages];
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const config = this.buildBladeConfig();

    this.agent = await Agent.create(config, {
      permissionMode: this.permissionMode,
      systemPrompt: this.options.systemPrompt,
      maxTurns: this.maxTurns,
    });

    this.initialized = true;

    logger.debug(`[Session] Initialized session ${this.sessionId}`);
  }

  async loadHistory(): Promise<void> {
    const workspaceRoot = this.options.cwd || process.cwd();
    const filePath = getSessionFilePath(workspaceRoot, this.sessionId);
    const store = new JSONLStore(filePath);

    try {
      const entries = await store.readAll();
      if (entries.length === 0) {
        logger.debug(`[Session] No history found for session ${this.sessionId}`);
        return;
      }

      interface MessageData {
        role: MessageRole;
        content: string;
        toolCalls: ChatCompletionMessageToolCall[];
        toolCallId?: string;
        name?: string;
      }

      const messageMap = new Map<string, MessageData>();
      const toolCallMap = new Map<string, { messageId: string; toolCallId: string }>();

      for (const entry of entries) {
        if (entry.type === 'message_created') {
          const data = entry.data as { messageId: string; role: MessageRole };
          messageMap.set(data.messageId, {
            role: data.role,
            content: '',
            toolCalls: [],
          });
        }

        if (entry.type === 'part_created') {
          const data = entry.data as {
            messageId: string;
            partType: string;
            payload: Record<string, unknown>;
          };
          let message = messageMap.get(data.messageId);
          if (!message) {
            const inferredRole: MessageRole =
              data.partType === 'tool_result' ? 'tool' : 'assistant';
            message = {
              role: inferredRole,
              content: '',
              toolCalls: [],
            };
            messageMap.set(data.messageId, message);
          }

          switch (data.partType) {
            case 'text': {
              const payload = data.payload as { text?: string };
              message.content = payload.text ?? '';
              break;
            }
            case 'tool_call': {
              const payload = data.payload as {
                toolCallId: string;
                toolName: string;
                input: unknown;
              };
              const toolCall: ChatCompletionMessageToolCall = {
                id: payload.toolCallId,
                type: 'function',
                function: {
                  name: payload.toolName,
                  arguments: typeof payload.input === 'string'
                    ? payload.input
                    : JSON.stringify(payload.input),
                },
              };
              message.toolCalls.push(toolCall);
              toolCallMap.set(payload.toolCallId, {
                messageId: data.messageId,
                toolCallId: payload.toolCallId,
              });
              break;
            }
            case 'tool_result': {
              const payload = data.payload as {
                toolCallId: string;
                toolName: string;
                output: unknown;
                error?: string | null;
              };
              message.role = 'tool';
              message.toolCallId = payload.toolCallId;
              message.name = payload.toolName;
              if (payload.error) {
                message.content = `Error: ${payload.error}`;
              } else if (payload.output === null || payload.output === undefined) {
                message.content = '';
              } else if (typeof payload.output === 'string') {
                message.content = payload.output;
              } else {
                message.content = JSON.stringify(payload.output);
              }
              break;
            }
            case 'summary': {
              const payload = data.payload as { text?: string };
              message.content = payload.text ?? '';
              break;
            }
          }
        }
      }

      this._messages = Array.from(messageMap.values()).map((msg): Message => {
        const base: Message = {
          role: msg.role,
          content: msg.content,
        };
        if (msg.toolCalls.length > 0) {
          base.tool_calls = msg.toolCalls;
        }
        if (msg.toolCallId) {
          base.tool_call_id = msg.toolCallId;
        }
        if (msg.name) {
          base.name = msg.name;
        }
        return base;
      });

      logger.debug(`[Session] Loaded ${this._messages.length} messages from history`);
    } catch (error) {
      logger.warn(`[Session] Failed to load history for session ${this.sessionId}:`, error);
    }
  }

  private buildBladeConfig(): BladeConfig {
    const modelConfig = this.buildModelConfig();

    return {
      models: [modelConfig],
      currentModelId: modelConfig.id,
      temperature: 0.7,
      mcpServers: this.options.mcpServers,
      permissions: {
        allow: [],
        deny: [],
      },
    };
  }

  private buildModelConfig(): ModelConfig {
    const provider = this.options.provider;

    return {
      id: 'default',
      name: this.options.model,
      provider: this.mapProviderType(provider.type),
      model: this.options.model,
      apiKey: provider.apiKey || '',
      baseUrl: provider.baseUrl || this.getDefaultBaseUrl(provider.type),
      maxTokens: 128000,
    };
  }

  private mapProviderType(type: ProviderConfig['type']): ProviderType {
    const mapping: Record<string, ProviderType> = {
      'openai-compatible': 'openai-compatible',
      anthropic: 'anthropic',
      gemini: 'gemini',
      'azure-openai': 'azure-openai',
      antigravity: 'antigravity',
      copilot: 'copilot',
    };
    return mapping[type] || 'openai-compatible';
  }

  private getDefaultBaseUrl(type: ProviderConfig['type']): string {
    const urls: Record<string, string> = {
      'openai-compatible': 'https://api.openai.com/v1',
      anthropic: 'https://api.anthropic.com',
      gemini: 'https://generativelanguage.googleapis.com',
      'azure-openai': '',
      antigravity: '',
      copilot: '',
    };
    return urls[type] || '';
  }

  async send(message: string, options?: SendOptions): Promise<void> {
    await this.ensureInitialized();

    if (this.pendingMessage !== null) {
      throw new Error('Cannot send a new message while a previous message is pending. Call stream() first.');
    }

    this.pendingMessage = message;
    this.pendingSendOptions = options || null;
  }

  async *stream(options?: StreamOptions): AsyncGenerator<StreamMessage> {
    if (this.pendingMessage === null) {
      throw new Error('No pending message. Call send() before stream().');
    }

    const message = this.pendingMessage;
    const sendOptions = this.pendingSendOptions;
    this.pendingMessage = null;
    this.pendingSendOptions = null;

    const toolCalls: ToolCallRecord[] = [];
    let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    this.abortController = new AbortController();
    const signal = sendOptions?.signal
      ? this.combineSignals(sendOptions.signal, this.abortController.signal)
      : this.abortController.signal;

    const contentQueue: StreamMessage[] = [];
    let queueResolve: (() => void) | null = null;

    const enqueue = (msg: StreamMessage) => {
      contentQueue.push(msg);
      if (queueResolve) {
        queueResolve();
        queueResolve = null;
      }
    };

    const context: ChatContext = {
      messages: this._messages,
      userId: 'sdk-user',
      sessionId: this.sessionId,
      workspaceRoot: this.options.cwd || process.cwd(),
      signal,
      permissionMode: this.permissionMode,
    };

    const loopOptions: LoopOptions = {
      maxTurns: sendOptions?.maxTurns ?? this.maxTurns,
      signal,
      stream: true,
      onTurnStart: (data) => {
        enqueue({ type: 'turn_start', turn: data.turn, sessionId: this.sessionId });
      },
      onContentDelta: (delta) => {
        enqueue({ type: 'content', delta, sessionId: this.sessionId });
      },
      onThinkingDelta: options?.includeThinking
        ? (delta) => {
            enqueue({ type: 'thinking', delta, sessionId: this.sessionId });
          }
        : undefined,
      onToolStart: (toolCall: ChatCompletionMessageToolCall) => {
        if (toolCall.type !== 'function') return;
        const input = this.safeParseJson(toolCall.function.arguments);
        toolCalls.push({
          id: toolCall.id,
          name: toolCall.function.name,
          input,
          output: null,
          duration: 0,
        });
        enqueue({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input,
          sessionId: this.sessionId,
        });
      },
      onToolResult: async (toolCall: ChatCompletionMessageToolCall, toolResult: ToolResult) => {
        if (toolCall.type !== 'function') return;
        const record = toolCalls.find((tc) => tc.id === toolCall.id);
        if (record) {
          record.output = toolResult.llmContent;
          record.isError = !toolResult.success;
        }
        enqueue({
          type: 'tool_result',
          id: toolCall.id,
          name: toolCall.function.name,
          output: toolResult.llmContent,
          isError: !toolResult.success,
          sessionId: this.sessionId,
        });
      },
      onTokenUsage: (usage) => {
        totalUsage = {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        };
      },
    };

    let done = false;

    const chatPromise = this.agent!.chat(message, context, loopOptions)
      .then((result) => {
        enqueue({ type: 'usage', usage: totalUsage, sessionId: this.sessionId });
        this._messages = context.messages;
        enqueue({
          type: 'result',
          subtype: 'success',
          content: result,
          sessionId: this.sessionId,
        });
      })
      .catch((error) => {
        const chatError = error instanceof Error ? error : new Error(String(error));
        enqueue({
          type: 'error',
          message: chatError.message,
          sessionId: this.sessionId,
        });
      })
      .finally(() => {
        done = true;
        if (queueResolve) queueResolve();
      });

    try {
      while (!done || contentQueue.length > 0) {
        if (contentQueue.length === 0 && !done) {
          await new Promise<void>((resolve) => {
            queueResolve = resolve;
          });
        }

        while (contentQueue.length > 0) {
          yield contentQueue.shift()!;
        }
      }

      await chatPromise;
    } finally {
      this.abortController = null;
    }
  }

  close(): void {
    this.abort();
    this.agent = null;
    this.initialized = false;
    this.pendingMessage = null;
    this.pendingSendOptions = null;
    logger.debug(`[Session] Closed session ${this.sessionId}`);
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  async setModel(_model: string): Promise<void> {
    logger.warn('[Session] setModel is not yet implemented');
  }

  setMaxTurns(maxTurns: number): void {
    this.maxTurns = maxTurns;
  }

  async supportedCommands(): Promise<SlashCommand[]> {
    const registry = CommandRegistry.getInstance();
    if (!registry.isInitialized()) {
      await registry.initialize(this.options.cwd || process.cwd());
    }

    return registry.getAllCommands().map((cmd) => ({
      name: cmd.name,
      description: cmd.config.description || '',
      usage: cmd.config.argumentHint,
    }));
  }

  async supportedModels(): Promise<ModelInfo[]> {
    return [
      {
        id: 'default',
        name: this.options.model,
        provider: this.options.provider.type,
      },
    ];
  }

  async mcpServerStatus(): Promise<McpServerStatus[]> {
    if (!this.agent) return [];

    const mcpServers = this.options.mcpServers || {};
    const statuses: McpServerStatus[] = [];

    for (const [name] of Object.entries(mcpServers)) {
      statuses.push({
        name,
        status: 'connected',
        toolCount: 0,
      });
    }

    return statuses;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private combineSignals(signal1: AbortSignal, signal2: AbortSignal): AbortSignal {
    const controller = new AbortController();

    const abort = () => controller.abort();

    if (signal1.aborted || signal2.aborted) {
      controller.abort();
    } else {
      signal1.addEventListener('abort', abort);
      signal2.addEventListener('abort', abort);
    }

    return controller.signal;
  }

  private safeParseJson(str: string): unknown {
    try {
      return JSON.parse(str);
    } catch {
      return str;
    }
  }
}

export async function createSession(options: SessionOptions): Promise<ISession> {
  const session = new Session(options);
  await session.initialize();
  logger.debug(`[Session] Created new session: ${session.sessionId}`);
  return session;
}

export async function resumeSession(options: ResumeOptions): Promise<ISession> {
  const { sessionId, ...sessionOptions } = options;
  const session = new Session(sessionOptions, sessionId);
  await session.initialize();
  await session.loadHistory();
  logger.debug(`[Session] Resumed session: ${sessionId} with ${session.messages.length} messages`);
  return session;
}

export async function prompt(
  message: string,
  options: SessionOptions
): Promise<PromptResult> {
  const startTime = Date.now();
  const session = new Session(options);
  await session.initialize();

  const toolCalls: ToolCallRecord[] = [];
  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let turnsCount = 0;
  let result = '';
  let errorMessage: string | null = null;

  try {
    await session.send(message);

    for await (const msg of session.stream()) {
      if (msg.type === 'turn_start') {
        turnsCount = msg.turn;
      } else if (msg.type === 'tool_use') {
        toolCalls.push({
          id: msg.id,
          name: msg.name,
          input: msg.input,
          output: null,
          duration: 0,
        });
      } else if (msg.type === 'tool_result') {
        const record = toolCalls.find((tc) => tc.id === msg.id);
        if (record) {
          record.output = msg.output;
          record.isError = msg.isError;
        }
      } else if (msg.type === 'usage') {
        totalUsage = msg.usage;
      } else if (msg.type === 'result' && msg.subtype === 'success') {
        result = msg.content || '';
      } else if (msg.type === 'error') {
        errorMessage = msg.message;
      } else if (msg.type === 'result' && msg.subtype === 'error') {
        errorMessage = msg.error || 'Unknown error';
      }
    }

    if (errorMessage) {
      throw new Error(errorMessage);
    }

    return {
      result,
      toolCalls,
      usage: totalUsage,
      duration: Date.now() - startTime,
      turnsCount,
    };
  } finally {
    session.close();
  }
}
