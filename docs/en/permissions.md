# Permissions

The Agent API exposes one permission surface,
`AgentOptions.advanced.permission`, which decides whether a tool call is
allowed, denied, or requires application approval.

## Permission presets

| Preset | Behavior |
|--------|----------|
| `'default'` | Ask for write and execute tools. |
| `'accept-edits'` | Allow file edits while still asking for command execution. |
| `'bypass-permissions'` | Auto-allow non-destructive operations; destructive operations still require explicit confirmation. |
| `'plan'` | Allow read-only tools. |

```ts
import { createAgent } from '@blade-ai/agent-sdk';

const agent = await createAgent({
  model,
  apiKey,
  advanced: {
    permission: 'accept-edits',
  },
});
```

`bypass-permissions` only makes the built-in mode handler allow
non-destructive operations by default. A destructive tool, tool-level `ask`,
custom handler, or sensitive-path confirmation can still ask the user. It
does not bypass tool validation or path safety.

For built-in file tools, sensitive-file detection classifies canonical paths
and filenames; it does not scan file contents. Treat it as one
permission-policy layer, not a secret scanner, and keep filesystem roots and
the OS sandbox narrowly scoped in production.

## Custom permission callback

The callback may return `'allow'`, `'deny'`, or `'ask'` for simple policies:

```ts
const agent = await createAgent({
  model,
  apiKey,
  advanced: {
    permission: async (request) => {
      if (
        request.toolName === 'Bash'
        && String(request.input.command ?? '').includes('rm -rf')
      ) {
        return {
          behavior: 'deny',
          message: 'Destructive deletion is not allowed',
        };
      }
      return request.kind === 'readonly' ? 'allow' : 'ask';
    },
  },
});
```

The callback receives the active Request `signal`, tool `kind`, side-effect
metadata, and `affectedPaths`. Return a full `PermissionResult` when the policy
needs to rewrite input, update permission rules, or provide a denial message:

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

## Low-level Session API

`createSession()` retains `permissionMode` and `permissionHandler` for
framework and runtime integrations. `canUseTool` is deprecated and remains
only for existing Session integrations; new code should not maintain three
parallel permission entry points.

The callback signal belongs to the active Request. The SDK races permission
callbacks, tool validation, tool-level permission checks, and interactive
confirmation against it. Interactive handlers receive the same signal as
`ConfirmationDetails.abortSignal`. These waits have no wall-clock timeout. A
callback that ignores cancellation remains tracked, blocks new tool work, and
prevents Session close or handoff until its Promise settles.

The root package exports composable permission helpers:

- `createModePermissionHandler()`
- `createPathSafetyPermissionHandler()`
- `createPermissionHandlerFromCanUseTool()`
- `createRuleBasedPermissionHandler()`
- `createCompositePermissionHandler()`

The four low-level `PermissionMode` values are `default`, `autoEdit`, `yolo`,
and `plan`. `session.setPermissionMode()` can still switch those modes at
runtime.

## Permission order

Permission modes are one part of the execution pipeline:

1. tool input validation;
2. tool-specific safety checks;
3. path safety;
4. configured permission policy;
5. interactive confirmation when the result is `ask`;
6. optional sandbox wrapping for built-in Bash.

This means an allowed permission result cannot make invalid input or an out-of-bounds filesystem path valid.

## Permissions and sandboxing

Permissions answer "may this tool call proceed?" Sandbox policy answers "what can this approved Bash command do at the OS boundary?"

They are independent. See [Sandbox](./sandbox) for availability checks and current platform limits.
