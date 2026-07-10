import type { ModelRequest } from '@blade-ai/ai';
import type { AgentHookPort } from '@blade-ai/agent/ports';
import type { HookRuntime } from '../hooks/HookRuntime.js';

export interface KernelHookPortOptions {
  hookRuntime: HookRuntime;
}

export function createKernelHookPort(options: KernelHookPortOptions): AgentHookPort {
  return {
    async beforeModel(request, context) {
      if (context.step !== 1) {
        return request;
      }

      const userMessageIndex = findLastUserMessageIndex(request);
      if (userMessageIndex === -1) {
        return request;
      }

      const userMessage = request.messages[userMessageIndex];
      if (!userMessage) {
        return request;
      }

      const rewritten = await options.hookRuntime.applyUserPromptSubmit(userMessage.content, {
        abortSignal: request.signal,
      });

      if (typeof rewritten !== 'string' || rewritten === userMessage.content) {
        return request;
      }

      return {
        ...request,
        messages: request.messages.map((message, index) =>
          index === userMessageIndex ? { ...message, content: rewritten } : message
        ),
      };
    },
  };
}

function findLastUserMessageIndex(request: ModelRequest): number {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    if (request.messages[index]?.role === 'user') {
      return index;
    }
  }

  return -1;
}
