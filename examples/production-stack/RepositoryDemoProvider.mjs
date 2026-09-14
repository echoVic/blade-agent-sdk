import { randomUUID } from 'node:crypto';
import { ProviderRegistry } from '@blade-ai/agent-sdk';
import { CORRECTED_GREETING, GREETING_PATH, ORIGINAL_GREETING } from './RepositoryTools.mjs';

const TOOL_NAMES = ['RepoRead', 'RepoWrite', 'RepoRunTests'];

function textOf(content) {
  return typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((part) => part.type === 'text').map((part) => part.text).join('')
      : '';
}

function toolReply(messages) {
  // A resumed continuation is a new user message. Inspect its current workspace
  // again instead of inferring completion from an earlier process's memory.
  const latestInput = messages.findLastIndex((message) => message.role === 'user');
  const current = messages.slice(latestInput + 1);
  const calls = new Map(current.flatMap((message) =>
    (message.tool_calls ?? []).map((call) => [call.id, call.function.name])));
  const last = current.findLast((message) => message.role === 'tool');
  if (!last) return null;
  const text = textOf(last.content);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { name: calls.get(last.tool_call_id), data, text };
}

function call(name, params) {
  return {
    content: '',
    toolCalls: [{
      id: `repo-${randomUUID()}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(params) },
    }],
  };
}

function nextResponse(messages) {
  const last = toolReply(messages);
  if (!last) return call('RepoRead', { file_path: GREETING_PATH });
  if (last.name === 'RepoWrite' && /denied|declined|rejected|cancelled|canceled|not approved|拒绝|取消/i.test(last.text)) {
    return { content: 'Write approval was denied or cancelled. No file changes were applied; tests were not run.' };
  }
  if (!last.data || last.data.error) {
    return { content: `Repository task stopped: ${last.data?.error ?? last.text}` };
  }
  if (last.name === 'RepoRead') {
    if (last.data.content === CORRECTED_GREETING) return call('RepoRunTests', {});
    if (last.data.content !== ORIGINAL_GREETING) {
      return { content: 'The offline demo found an unfamiliar greeting implementation and left it unchanged. Use a model provider to handle another change.' };
    }
    return call('RepoWrite', {
      file_path: GREETING_PATH,
      expected_content: last.data.content,
      content: CORRECTED_GREETING,
    });
  }
  if (last.name === 'RepoWrite') return call('RepoRunTests', {});
  if (last.name === 'RepoRunTests') {
    return { content: last.data.passed
      ? `src/greeting.sh now produces Hello, Blade!\nTests passed (exit ${last.data.exitCode}).\n${last.data.stdout.trim()}`
      : `Greeting tests failed (exit ${last.data.exitCode}).\n${last.data.stdout}${last.data.stderr}` };
  }
  return { content: 'Repository task stopped after an unexpected tool response.' };
}

export function createRepositorySessionOptions({
  smoke = false,
  tools = [],
  confirmationHandlerFactory,
  confirmationHandler,
} = {}) {
  const apiKey = smoke ? undefined : process.env.OPENAI_API_KEY;
  const providerRegistry = apiKey ? undefined : new ProviderRegistry([{
    type: 'repository-demo',
    create(config) {
      return {
        async chat(messages, _tools, signal) {
          signal?.throwIfAborted();
          return nextResponse(messages);
        },
        async sideQuery(_messages, signal) {
          signal?.throwIfAborted();
          return { content: 'Read the greeting fixture, obtain write approval, fix the greeting, and run its tests.' };
        },
        async *streamChat(messages, _tools, signal) {
          signal?.throwIfAborted();
          const response = nextResponse(messages);
          yield response;
          signal?.throwIfAborted();
          yield {
            finishReason: response.toolCalls ? 'tool_calls' : 'stop',
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          };
        },
        getConfig() { return config; },
        updateConfig() {},
      };
    },
  }]);
  return {
    provider: apiKey ? { type: 'openai', apiKey } : { type: 'repository-demo' },
    providerRegistry,
    model: apiKey ? process.env.OPENAI_MODEL || 'gpt-5-mini' : 'repository-demo',
    tools,
    allowedTools: TOOL_NAMES,
    maxTurns: 12,
    toolTimeoutMs: 5 * 60_000,
    confirmationHandlerFactory: (sessionId) => {
      const interactive = confirmationHandlerFactory?.(sessionId) ?? confirmationHandler;
      return {
        async requestConfirmation(details) {
          details.abortSignal?.throwIfAborted();
          // SDK rule checks can request confirmation even for an allowed custom
          // tool. This example preauthorizes its bounded read and fixed tests.
          if (details.toolName === 'RepoRead' || details.toolName === 'RepoRunTests') {
            return { approved: true, scope: 'once' };
          }
          if (details.toolName === 'RepoWrite' && interactive) {
            const response = await interactive.requestConfirmation(details);
            return response.approved ? response : {
              ...response,
              reason: `${response.reason ?? 'Write approval denied'}. No file changes were applied by this write.`,
            };
          }
          return { approved: false, reason: 'Writing requires explicit user approval. No file changes were applied by this write.' };
        },
      };
    },
    permissionHandler: async ({ toolName }) => {
      if (toolName === 'RepoWrite') return { behavior: 'ask', message: 'Approve this change to src/greeting.sh?' };
      if (toolName === 'RepoRead' || toolName === 'RepoRunTests') return { behavior: 'allow' };
      return { behavior: 'deny', message: 'Only the repository fixture tools are available' };
    },
    systemPrompt: 'You maintain a small isolated shell repository. Read src/greeting.sh and, when helpful, test/greeting.test.sh. Follow the user request using only the repository tools. The initial task is to make the greeting produce Hello, Blade! and preserve the default Hello, World! greeting. Supply the exact previously read text as expected_content when writing. The user must approve changes; if approval is denied, stop and explain that the file remains unchanged. Run RepoRunTests after a change and report its actual exit code and output. Do not claim tests passed without a passing tool result. After recovery, read the current source before deciding whether another write is needed.',
  };
}
