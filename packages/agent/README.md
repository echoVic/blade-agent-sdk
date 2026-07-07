# @blade-ai/agent

Runtime-independent agent kernel contracts for Blade Agent.

Use this package when you need the core `AgentKernel` without the session-first product SDK. The kernel runs turns through injected ports for model, tools, permissions, hooks, trace, and store. It does not own Node-local capabilities, MCP clients, filesystem access, shell execution, provider SDKs, or session persistence.

## Installation

```bash
pnpm add @blade-ai/agent
```

## Usage

```ts
import { AgentKernel } from '@blade-ai/agent';
import { TokenBudget } from '@blade-ai/agent/budget';
import { ExecutionEpoch } from '@blade-ai/agent/epoch';
import {
  isValidSystemSource,
  modelResponseToAssistantMessage,
  toolResultToToolMessage,
} from '@blade-ai/agent/state';
import {
  AsyncEventQueue,
  createInterruptAwareAbortSignal,
  decideNoToolTurn,
  decideTurnLimit,
  planToolExecution,
  resolveToolInterruptBehavior,
  toolUpdateToAgentEvent,
  ToolKind,
} from '@blade-ai/agent/loop';
import { isOverflowRecoverable } from '@blade-ai/agent/recovery';

const kernel = new AgentKernel({
  model,
  tools,
  permissions,
  tokenBudget: new TokenBudget({ maxTotalTokens: 128_000 }),
});

for await (const event of kernel.runTurn({ input: 'hello' })) {
  // handle content, tool_use, tool_result, usage,
  // budget_warning, budget_exhausted, result, error
}

const epoch = new ExecutionEpoch();
epoch.invalidate();

const queue = new AsyncEventQueue<string>();
queue.close();

await decideNoToolTurn('All done', [], 1);
await decideTurnLimit({
  maxTurns: 1,
  turnsCount: 1,
  contextMessages: [],
  toolCallsCount: 0,
  startTime: Date.now(),
  totalTokens: 0,
});
planToolExecution(
  [{ id: 'read-1', type: 'function', function: { name: 'Read', arguments: '{}' } }],
  { get: () => ({ kind: ToolKind.ReadOnly }) },
);
resolveToolInterruptBehavior(
  { get: () => ({ kind: ToolKind.Execute, interruptBehavior: 'cancel' }) },
  'Bash',
  {},
);
createInterruptAwareAbortSignal({ interruptBehavior: 'cancel' }).cleanup();
toolUpdateToAgentEvent(
  { type: 'tool_ready', toolCall: { id: 'read-1', type: 'function', function: { name: 'Read', arguments: '{}' } } },
  { get: () => ({ kind: ToolKind.ReadOnly }) },
);

isOverflowRecoverable(new Error('context_length_exceeded')); // true
isValidSystemSource('catalog'); // true
modelResponseToAssistantMessage({ content: 'hello' });
toolResultToToolMessage(
  { id: 'call_read', name: 'Read', output: 'ok' },
  { id: 'fallback', name: 'Fallback' },
);
```

Most application code should use `@blade-ai/agent-sdk`. Use `@blade-ai/agent` directly for runtime-independent adapters, kernel tests, or non-Node hosts that provide their own ports.

Full example: `examples/agent-kernel.ts` in the repository.
