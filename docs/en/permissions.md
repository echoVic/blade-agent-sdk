# Permissions

The permission pipeline controls whether a tool call is allowed, denied, or requires application approval.

## PermissionMode

| Constant | Value | Behavior |
|----------|-------|----------|
| `PermissionMode.DEFAULT` | `default` | Ask for write and execute tools. |
| `PermissionMode.AUTO_EDIT` | `autoEdit` | Allow file edits while still asking for command execution. |
| `PermissionMode.YOLO` | `yolo` | Auto-allow non-destructive operations; destructive operations still require explicit confirmation. |
| `PermissionMode.PLAN` | `plan` | Allow read-only tools. |

```ts
import { createSession, PermissionMode } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider,
  model,
  permissionMode: PermissionMode.DEFAULT,
});

session.setPermissionMode(PermissionMode.AUTO_EDIT);
```

`YOLO` only makes the built-in mode handler allow non-destructive operations
by default. A destructive tool, tool-level `ask`, custom handler, or
sensitive-path confirmation can still ask the user. It does not bypass tool
validation or path safety.

For built-in file tools, sensitive-file detection classifies canonical paths
and filenames; it does not scan file contents. Treat it as one
permission-policy layer, not a secret scanner, and keep filesystem roots and
the OS sandbox narrowly scoped in production.

## canUseTool

```ts
import type { CanUseTool } from '@blade-ai/agent-sdk';

const canUseTool: CanUseTool = async (toolName, input, options) => {
  if (
    toolName === 'Bash'
    && String(input.command ?? '').includes('rm -rf')
  ) {
    return {
      behavior: 'deny',
      message: 'Destructive deletion is not allowed',
    };
  }

  if (options.toolKind === 'readonly') {
    return { behavior: 'allow' };
  }

  return {
    behavior: 'ask',
    message: `Approve ${toolName}?`,
  };
};

const session = await createSession({
  provider,
  model,
  canUseTool,
});
```

## PermissionResult

```ts
type PermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: JsonObject;
      effects?: ToolEffect[];
      updatedPermissions?: PermissionUpdate[];
    }
  | {
      behavior: 'deny';
      message: string;
      interrupt?: boolean;
    }
  | {
      behavior: 'ask';
      message?: string;
    };
```

- `updatedInput` changes the parameters passed to the tool.
- `effects` applies structured runtime effects.
- `updatedPermissions` adds or removes permission rules.
- `interrupt` requests request-level interruption after denial.

## CanUseToolOptions

```ts
interface CanUseToolOptions {
  signal: AbortSignal;
  toolKind: ToolKind;
  sideEffect: ToolSideEffect;
  affectedPaths: string[];
}
```

The signal belongs to the active Request. The SDK races `canUseTool`,
`permissionHandler`, tool validation, tool-level permission checks, and
interactive confirmation against it. Interactive handlers receive the same
signal as `ConfirmationDetails.abortSignal`. These waits have no wall-clock
timeout. A callback that ignores cancellation remains tracked, blocks new tool
work, and prevents Session close or handoff until its Promise settles.

## Low-level handlers

The root package exports composable permission helpers:

- `createModePermissionHandler()`
- `createPathSafetyPermissionHandler()`
- `createPermissionHandlerFromCanUseTool()`
- `createRuleBasedPermissionHandler()`
- `createCompositePermissionHandler()`

Use `permissionHandler` when an application needs direct control over the full `PermissionHandlerRequest`. Most integrations should use `permissionMode` plus `canUseTool`.
When both callbacks are configured, `permissionHandler` takes precedence and
`canUseTool` is not invoked.

## Permission order

Permission modes are one part of the execution pipeline:

1. tool input validation;
2. tool-specific safety checks;
3. path safety;
4. configured permission handler or `canUseTool`;
5. interactive confirmation when the result is `ask`;
6. optional sandbox wrapping for built-in Bash.

This means an allowed permission result cannot make invalid input or an out-of-bounds filesystem path valid.

## Permissions and sandboxing

Permissions answer "may this tool call proceed?" Sandbox policy answers "what can this approved Bash command do at the OS boundary?"

They are independent. See [Sandbox](./sandbox) for availability checks and current platform limits.
