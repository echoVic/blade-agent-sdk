import type { UserMessageContent } from '../agent/types.js';
import type { TokenUsage } from '../model/usage.js';
import type { MessageId } from '../types/identifiers.js';
import { AgentSession } from './AgentSession.js';
import { SERVER_SESSION_HOST, type SessionHostProfile } from './SessionHostProfile.js';
import { hasSessionPersistence } from './SessionState.js';
import type { ISession, PromptResult, SessionOptions, ToolExecutionRecord } from './types.js';

export interface ResumeOptions extends SessionOptions {
  sessionId: ISession['sessionId'];
}

export interface ForkOptions extends ResumeOptions {
  messageId?: MessageId;
}

export async function createSession(options: SessionOptions): Promise<ISession> {
  return createSessionWithHost(options, SERVER_SESSION_HOST);
}

export async function createSessionWithHost(
  options: SessionOptions,
  hostProfile: SessionHostProfile,
): Promise<ISession> {
  const session = new AgentSession(options, undefined, false, hostProfile);
  await session.initialize();
  return session;
}

export async function resumeSession(options: ResumeOptions): Promise<ISession> {
  return resumeSessionWithHost(options, SERVER_SESSION_HOST);
}

export async function resumeSessionWithHost(
  options: ResumeOptions,
  hostProfile: SessionHostProfile,
): Promise<ISession> {
  if (options.persistSession === false || !hasSessionPersistence(options)) {
    throw new Error(
      'resumeSession() requires session persistence through ' +
        'sessionRepository and sessionEventStore.',
    );
  }
  const { sessionId, ...sessionOptions } = options;
  const session = new AgentSession(sessionOptions, sessionId, true, hostProfile);
  try {
    await session.initialize();
    await session.loadHistory();
    return session;
  } catch (error) {
    await session.disposeAfterFork();
    throw error;
  }
}

export async function forkSession(options: ForkOptions): Promise<ISession> {
  return forkSessionWithHost(options, SERVER_SESSION_HOST);
}

export async function forkSessionWithHost(
  options: ForkOptions,
  hostProfile: SessionHostProfile,
): Promise<ISession> {
  if (options.persistSession === false || !hasSessionPersistence(options)) {
    throw new Error(
      'forkSession() requires session persistence through ' +
        'sessionRepository and sessionEventStore. ' +
        'Use session.fork() for an in-memory Session.',
    );
  }
  const { sessionId, messageId, ...sessionOptions } = options;

  const sourceSession = new AgentSession(sessionOptions, sessionId, true, hostProfile);
  await sourceSession.initialize();
  await sourceSession.loadHistory();

  try {
    return await sourceSession.fork({ messageId });
  } finally {
    await sourceSession.disposeAfterFork();
  }
}

export async function prompt(
  message: UserMessageContent,
  options: SessionOptions,
): Promise<PromptResult> {
  return promptWithHost(message, options, SERVER_SESSION_HOST);
}

export async function promptWithHost(
  message: UserMessageContent,
  options: SessionOptions,
  hostProfile: SessionHostProfile,
): Promise<PromptResult> {
  const startTime = Date.now();
  const session = new AgentSession(options, undefined, false, hostProfile);
  await session.initialize();

  const toolCalls: ToolExecutionRecord[] = [];
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

    for await (const event of session.stream()) {
      if (event.type === 'turn_start') {
        turnsCount = event.turn;
      } else if (event.type === 'tool_use') {
        toolCalls.push({
          id: event.id,
          name: event.name,
          input: event.input,
          output: '',
          duration: 0,
        });
      } else if (event.type === 'tool_result') {
        const record = toolCalls.find((toolCall) => toolCall.id === event.id);
        if (record) {
          record.output = event.output;
          record.isError = event.isError;
        }
      } else if (event.type === 'usage') {
        totalUsage = event.usage;
      } else if (event.type === 'result' && event.subtype === 'success') {
        result = event.content || '';
      } else if (event.type === 'error') {
        errorMessage = event.message;
      } else if (event.type === 'result' && event.subtype === 'error') {
        errorMessage = event.error || 'Unknown error';
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
