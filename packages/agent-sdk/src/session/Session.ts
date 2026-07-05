import type { SessionRuntimeFactory } from './factory.js';
import type { TokenUsage } from '../types/common.js';
import type {
  ForkOptions,
  ISession,
  PromptResult,
  ResumeOptions,
  SessionOptions,
  ToolCallRecord,
  UserMessageContent,
} from './types.js';

export async function createSession(
  runtime: SessionRuntimeFactory,
  options: SessionOptions,
): Promise<ISession> {
  return runtime.create(options);
}

export async function resumeSession(
  runtime: SessionRuntimeFactory,
  options: ResumeOptions,
): Promise<ISession> {
  if (options.persistSession === false) {
    throw new Error(
      'resumeSession() requires session persistence. Remove persistSession: false or use createSession().',
    );
  }
  return runtime.resume(options);
}

export async function forkSession(
  runtime: SessionRuntimeFactory,
  options: ForkOptions,
): Promise<ISession> {
  if (options.persistSession === false) {
    throw new Error(
      'forkSession() requires session persistence. Remove persistSession: false and call session.fork() on a live session instead.',
    );
  }
  const { messageId } = options;
  const sourceSession = await runtime.resume(options);

  try {
    return await sourceSession.fork({ messageId });
  } finally {
    await sourceSession.close();
  }
}

export async function prompt(
  runtime: SessionRuntimeFactory,
  message: UserMessageContent,
  options: SessionOptions,
): Promise<PromptResult> {
  const startTime = Date.now();
  const session = await runtime.create(options);
  const toolCalls: ToolCallRecord[] = [];
  let totalUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    maxContextTokens: 0,
  };
  let turnsCount = 0;
  let result = '';
  let errorMessage: string | null = null;

  try {
    await session.send(message);

    for await (const streamMessage of session.stream()) {
      switch (streamMessage.type) {
        case 'turn_start':
          turnsCount = streamMessage.turn;
          break;
        case 'tool_use':
          toolCalls.push({
            id: streamMessage.id,
            name: streamMessage.name,
            input: streamMessage.input,
            output: '',
            duration: 0,
          });
          break;
        case 'tool_result': {
          const record = toolCalls.find((toolCall) => toolCall.id === streamMessage.id);
          if (record) {
            record.output = streamMessage.output;
            record.isError = streamMessage.isError;
          }
          break;
        }
        case 'usage':
          totalUsage = streamMessage.usage;
          break;
        case 'result':
          if (streamMessage.subtype === 'success') {
            result = streamMessage.content ?? '';
          } else {
            errorMessage = streamMessage.error ?? 'Unknown error';
          }
          break;
        case 'error':
          errorMessage = streamMessage.message;
          break;
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
    await session.close();
  }
}
