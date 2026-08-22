# Subagents

A Session has its own `SubagentRegistry`. Subagents can isolate context, restrict tools, select a model, and run work in the foreground or background.

## Built-in agents

| Name | Purpose |
|------|---------|
| `general-purpose` | General delegated tasks |
| `Explore` | Code search and analysis |
| `Plan` | Implementation planning |

Explore and Plan omit environment context internally to save tokens. That internal setting is not part of the public `AgentDefinition` accepted by `SessionOptions.agents`.

## Define a Session-local agent

```ts
const session = await createSession({
  provider,
  model,
  agents: {
    verification: {
      name: 'verification',
      description: 'Review changes for correctness, risk, and missing tests',
      systemPrompt:
        'Review code strictly. Prioritize correctness, security, and tests.',
      allowedTools: ['Read', 'Glob', 'Grep'],
      model: 'gpt-4o',
    },
    'test-writer': {
      name: 'Test Writer',
      description: 'Write and maintain focused tests',
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    },
  },
});
```

- Agent definitions are scoped to one Session.
- A Session-local definition replaces a built-in or discovered definition with the same name.
- Product roles such as `verification` are application policy and must be registered explicitly.

## AgentDefinition

```ts
interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt?: string;
  allowedTools?: string[];
  model?: string;
}
```

| Field | Meaning |
|-------|---------|
| `name` | Display and lookup name |
| `description` | Delegation guidance for the model |
| `systemPrompt` | Agent-specific instructions |
| `allowedTools` | Tool allowlist |
| `model` | Optional model override |

## Background agents

The built-in `Task` tool can start a subagent without blocking the main conversation:

1. `Task` creates the work and returns a task ID.
2. The subagent runs with separate execution state.
3. `TaskOutput` reads status and output.
4. `TaskStop` requests cancellation.

The model may produce a sequence such as:

```text
Task       { prompt: "Find all untested persistence paths" }
TaskOutput { task_id: "agent-..." }
TaskStop   { taskId: "agent-..." }
```

Background agents separate lifecycle cancellation from the current work-unit signal. Stopping the lifecycle cascades to active work while allowing cleanup to run.

## Registry APIs

The root package exports:

- `SubagentRegistry`
- `SubagentExecutor`
- `SubagentConfig`
- `SubagentContext`
- `SubagentResult`
- `SubagentSource`

Use these lower-level APIs when an application needs custom discovery or execution outside `SessionOptions.agents`.

## Safety

Tool restrictions on a subagent reduce its exposed surface but do not replace permission checks or sandboxing. A delegated agent uses the runtime and security boundary supplied by the parent application.
