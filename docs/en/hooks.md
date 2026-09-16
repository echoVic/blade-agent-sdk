# Hooks

The SDK has two hook systems with intentionally separate configuration surfaces:

| Hook | API location | Purpose |
|------|--------------|---------|
| Inline hooks | `AgentOptions.advanced.hooks`; low-level `SessionOptions.hooks` | In-process TypeScript callbacks |
| Shell hooks | `HookConfig` in CLI or host configuration | Commands launched and isolated by the host |

`createAgent()` accepts inline hooks only; it does not accept `HookConfig`.
Session does not scan `.blade/hooks/` or any other file-hook directory.
Shell-hook discovery, loading, and process permissions belong to the CLI or
host integration.

## Quick start

```ts
import { createAgent, HookEvent } from '@blade-ai/agent-sdk';

const agent = await createAgent({
  model,
  apiKey,
  advanced: {
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
  },
});
```

## Session hook events

The exported `HookEvent` object contains 22 events used across the SDK and
shell-hook protocol. `AgentOptions.advanced.hooks` and `SessionOptions.hooks`
accept these eight `SessionHookEvent` values. The type is exported from the
root entry point.

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
  abortSignal?: AbortSignal;
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

## Deadlines and cancellation

Each inline hook event has one wall-clock budget shared by its callbacks in
registration order. `AgentOptions.advanced.hookTimeoutMs` defaults to `600000`
(10 minutes). `SessionEnd` uses the shorter
`advanced.sessionEndHookTimeoutMs`, which defaults to `3000`. Low-level
`SessionOptions` uses the same field names.

The SDK combines the caller signal with the deadline and exposes it as
`HookInput.abortSignal`. A deadline rejects the event with `HookTimeoutError`
and code `HOOK_TIMEOUT`. Callback implementations must observe the signal and
release resources. If a callback remains pending after cancellation, later
inline hook dispatches and Session close or handoff fail closed until it
settles. These options do not replace the independent timeout configuration
used by file hooks.

File/command hooks check the Request signal before spawning. On POSIX,
cancellation or a file-hook timeout terminates the process group, waits briefly
after `SIGTERM`, and escalates to `SIGKILL` when needed. On Windows, the command
is admitted to a Job Object before it can spawn descendants and cancellation
terminates the complete Job. The Hook does not report successful cleanup until
the owned process tree has exited; containment failures reject instead of
following the configured Hook failure policy. Windows command hooks also fail
closed before spawning when the `koffi` native binding is unavailable. The
runtime checks the signal again after each file hook, so the default `ignore`
failure policy cannot resume an already-cancelled Request.
If a containment failure arrives after cancellation has already won an
asynchronous tool or permission race, the execution pipeline is quarantined:
later tool calls and Session close or handoff remain fail-closed.
That state cannot be reset on the same pipeline. Stop using and recreate the
owning Agent or Session runtime instead of retrying the quarantined instance.
Closing the old runtime may report the same terminal failure.

On POSIX, containment follows process-group semantics. A Hook command that
deliberately creates a new session with `setsid()` leaves the SDK-owned process
group and is outside this portable cleanup boundary.

`SessionEnd` callbacks are one-shot for a runtime shutdown attempt. A failed or
timed-out callback is not invoked again when `close()` is retried; file hooks
retain their existing retry behavior.

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
| `advanced.permission` | Decide allow, deny, or ask | String or `PermissionResult` |

Use `advanced.permission` for authorization policy:

```ts
const agent = await createAgent({
  model,
  apiKey,
  advanced: {
    permission: async (request) =>
      request.kind === 'readonly' ? 'allow' : 'ask',
  },
});
```

`SessionOptions.permissionHandler` remains the low-level runtime extension point.

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
