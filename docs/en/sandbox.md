# Sandbox

Sandbox support provides best-effort operating-system isolation for the built-in `Bash` tool. Linux uses Bubblewrap and macOS uses Seatbelt (`sandbox-exec`). Permissions decide whether a call may proceed; the sandbox attempts to restrict an approved command.

::: danger Check runtime availability
`sandbox.enabled: true` does not guarantee that a sandbox executor exists on the host. When none is available, the current implementation executes the original command. Production applications must inspect `getSandboxService().getCapabilities().available` and fail closed or disable `Bash`.
:::

## Safe initialization

```ts
import {
  createSession,
  PermissionMode,
} from '@blade-ai/agent-sdk';
import { getSandboxService } from '@blade-ai/agent-sdk/local';

const sandbox = getSandboxService();
sandbox.configure({
  enabled: true,
});

if (!sandbox.getCapabilities().available) {
  throw new Error('Required OS sandbox is unavailable');
}

const session = await createSession({
  provider,
  model,
  permissionMode: PermissionMode.DEFAULT,
  sandbox: sandbox.getSettings(),
});
```

## SandboxSettings

```ts
interface SandboxSettings {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  excludedCommands?: string[];
  allowUnsandboxedCommands?: boolean;
  network?: NetworkSandboxSettings;
  ignoreViolations?: SandboxIgnoreViolations;
  enableWeakerNestedSandbox?: boolean;
}
```

| Option | Default | Current behavior |
|--------|---------|------------------|
| `enabled` | `false` | Request OS sandboxing for `Bash`. |
| `autoAllowBashIfSandboxed` | `false` | Queryable configuration metadata. The current execution pipeline does not consume it, so it does not guarantee automatic approval. |
| `excludedCommands` | `[]` | Affects sandbox classification; the command wrapper may still sandbox these commands. Do not rely on it as a bypass. |
| `allowUnsandboxedCommands` | `false` | Allow an explicit unsandboxed request passed to `SandboxService.checkCommand()` to enter permission review. Built-in Bash does not currently expose that request flag. |
| `network` | unset | Network options passed to the command wrapper. |
| `ignoreViolations` | unset | Queryable metadata; the current command wrapper does not apply these rules. |
| `enableWeakerNestedSandbox` | `false` | Reserved; the current command wrapper does not read it. |

## Capabilities

```ts
const capabilities = getSandboxService().getCapabilities();

console.log(capabilities.available);
console.log(capabilities.type); // 'bubblewrap' | 'seatbelt' | 'none'
console.log(capabilities.features);
```

Treat `available === false` as a deployment configuration failure when isolation is required. The SDK does not currently fail closed.

## Filesystem boundary

When enabled and available:

- the working directory is writable;
- required system directories and binaries are exposed according to the platform profile;
- temporary directories are writable;
- selected package-manager directories may be exposed.

The wrapper only covers the built-in `Bash` tool. Custom tools and remote MCP servers need their own process, container, or service boundary.

## Network settings

```ts
interface NetworkSandboxSettings {
  allowLocalBinding?: boolean;
  allowUnixSockets?: string[];
  allowAllUnixSockets?: boolean;
  httpProxyPort?: number;
  socksProxyPort?: number;
}
```

The current command wrapper only consumes `allowLocalBinding`:

- `allowLocalBinding: false` disables all network access for the command.
- omitted or `true` leaves network access enabled.

`allowUnixSockets`, `allowAllUnixSockets`, `httpProxyPort`, and `socksProxyPort` are stored by the configuration service but are not yet applied to Bubblewrap or Seatbelt command wrapping.

## Layering

| Layer | Responsibility |
|-------|----------------|
| Input validation and path safety | Reject invalid input and out-of-scope filesystem paths. |
| `permissionMode` / `canUseTool` | Decide allow, deny, or ask. |
| Sandbox | Restrict the OS capabilities of an approved Bash command. |

`PermissionMode.YOLO` skips interactive confirmation but does not bypass validation or path safety. It also does not make an unavailable sandbox available.

## Recommended production policy

```ts
const sandbox = getSandboxService();
sandbox.configure({
  enabled: true,
  autoAllowBashIfSandboxed: false,
  network: {
    allowLocalBinding: false,
  },
});

if (!sandbox.getCapabilities().available) {
  throw new Error('Sandbox is required for this deployment');
}
```

Also:

1. use `allowedTools` or `disallowedTools` to control whether `Bash` is exposed;
2. use `canUseTool` for application policy;
3. do not treat ignored violations or Unix socket options as enforced isolation;
4. isolate custom tools and MCP servers separately.

## Troubleshooting

### Commands are not wrapped

```ts
const service = getSandboxService();
console.log(service.isEnabled());
console.log(service.getCapabilities());
```

If `available` is false, the original command is executed.

### All network access is blocked

Check for:

```ts
network: {
  allowLocalBinding: false,
}
```

The current implementation maps this value to disabling all network access, not only local port binding.
