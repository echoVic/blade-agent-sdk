# Hooks

`SessionOptions.hooks` registers in-process callbacks that observe prompts, modify tool input or output, and block the current operation. Session does not automatically scan `.blade/hooks/` or any other file-hook directory; applications must integrate file-based hooks separately.

## Quick start

```ts
import { createSession, HookEvent } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider,
  model,
  hooks: {
    [HookEvent.PreToolUse]: [
      async (input) => {
        console.log('Tool call', input.toolName, input.toolInput);
        return { action: 'continue' };
      },
    ],
    [HookEvent.PostToolUseFailure]: [
      async (input) => {
        console.error('Tool failed', input.toolName, input.error);
        return { action: 'continue' };
      },
    ],
  },
});
```

## Session hook events

The exported `HookEvent` object contains 22 events used across the SDK and file-hook protocol. `SessionOptions.hooks` accepts these eight `SessionHookEvent` values:

Import the `SessionHookEvent` type from `@blade-ai/agent-sdk/session`; the root
entry point does not currently re-export it.

| Event | Timing |
|-------|--------|
| `SessionStart` | Session initialization completed. |
| `UserPromptSubmit` | Before user input enters the Agent loop. |
| `PreToolUse` | Before permission checks and tool execution. |
| `PermissionRequest` | When a tool requires a permission decision. |
| `PostToolUse` | After a successful tool result. |
| `PostToolUseFailure` | After a failed tool result. |
| `TaskCompleted` | A task completed. |
| `SessionEnd` | The Session closed. |

## Types

```ts
interface HookInput {
  event: HookEvent;
  toolName?: string;
  toolInput?: JsonObject;
  toolOutput?: ToolModelContent;
  error?: Error;
  sessionId: SessionId;
  [key: string]: unknown;
}

interface HookOutput {
  action: 'continue' | 'skip' | 'abort';
  modifiedInput?: JsonObject | string;
  modifiedOutput?: JsonValue;
  reason?: string;
}

type HookCallback = (input: HookInput) => Promise<HookOutput>;
```

`skip` avoids execution and produces a successful result containing the
reason. `abort` produces an error result. Neither action permanently closes
the Session.

## Modify a prompt

`UserPromptSubmit` uses the `userPrompt` field:

```ts
hooks: {
  [HookEvent.UserPromptSubmit]: [
    async (input) => ({
      action: 'continue',
      modifiedInput: {
        userPrompt: `[tenant:acme]\n${String(input.userPrompt ?? '')}`,
      },
    }),
  ],
}
```

Returning a bare string as `modifiedInput` remains supported for compatibility.

## Modify tool input

```ts
hooks: {
  [HookEvent.PreToolUse]: [
    async (input) => {
      if (input.toolName !== 'Write') {
        return { action: 'continue' };
      }
      return {
        action: 'continue',
        modifiedInput: {
          ...input.toolInput,
          content: `// Generated\n${String(input.toolInput?.content ?? '')}`,
        },
      };
    },
  ],
}
```

## Block a tool

```ts
hooks: {
  [HookEvent.PreToolUse]: [
    async (input) => {
      const command = String(input.toolInput?.command ?? '');
      if (input.toolName === 'Bash' && /rm\s+-rf/.test(command)) {
        return {
          action: 'abort',
          reason: 'Destructive deletion is not allowed',
        };
      }
      return { action: 'continue' };
    },
  ],
}
```

The blocked tool receives a terminal error result so the model protocol remains valid.

## Modify tool output

```ts
hooks: {
  [HookEvent.PostToolUse]: [
    async (input) => ({
      action: 'continue',
      modifiedOutput: String(input.toolOutput)
        .replace(/SECRET_KEY=\w+/g, 'SECRET_KEY=***'),
    }),
  ],
}
```

`modifiedOutput` changes the model-facing `ToolResult.model`, not UI-only `display` content.

## Hooks and permissions

| Mechanism | Purpose | Result |
|-----------|---------|--------|
| `PreToolUse` / `PostToolUse` | Observe, block, or transform tool calls | `HookOutput` |
| `PermissionRequest` | Observe permission requests | `HookOutput` |
| `canUseTool` | Decide allow, deny, or ask | `PermissionResult` |

Use `canUseTool` for authorization policy.

## Ordering and errors

Callbacks for one event are invoked in array order. Dispatch collects every callback result before processing actions:

```ts
hooks: {
  [HookEvent.PreToolUse]: [hookA, hookB, hookC],
}
```

- `hookB` and `hookC` still run when `hookA` returns `skip` or `abort`.
- Every callback receives the original input; later callbacks do not receive earlier `modifiedInput`.
- Results are then processed in order, merging modifications until the first `skip` or `abort`.
- Errors from prompt and other non-tool hooks propagate to the caller.
- Tool-hook errors are normalized into tool failures. If a
  `PostToolUseFailure` hook also throws, the SDK logs a warning and keeps the
  original tool error.

Catch recoverable failures inside non-critical audit or telemetry hooks:

```ts
async (input) => {
  try {
    await telemetry.send(input);
  } catch (error) {
    console.error('Hook telemetry failed', error);
  }
  return { action: 'continue' };
};
```
