# @blade-ai/agent

Runtime-independent agent kernel contracts for Blade Agent.

Use this package when you need the core `AgentKernel` without the session-first product SDK. The kernel runs turns through injected ports for model, tools, permissions, hooks, trace, and store. It does not own Node-local capabilities, MCP clients, filesystem access, shell execution, provider SDKs, or session persistence.

```ts
import { AgentKernel } from '@blade-ai/agent';

const kernel = new AgentKernel({
  model,
  tools,
  permissions,
});

for await (const event of kernel.runTurn({ input: 'hello' })) {
  // handle content, tool_use, tool_result, usage, result, error
}
```

Most application code should use `@blade-ai/agent-sdk`. Use `@blade-ai/agent` directly for runtime-independent adapters, kernel tests, or non-Node hosts that provide their own ports.

Full example: `examples/agent-kernel.ts` in the repository.
