# Execution Host

`ExecutionHost` is the stable boundary between a scheduler and a task
environment. Server code depends only on `provision`, `exec`, `checkpoint`,
`restore`, and `terminate`, without coupling to containers, virtual machines,
or remote workers.

```ts
import type { ExecutionHost } from '@blade-ai/agent-sdk/server';
import {
  DockerExecutionHost,
  EphemeralCredentialBroker,
  ExecutionId,
} from '@blade-ai/agent-sdk/node';
```

`DockerExecutionHost` is the Node.js reference implementation. Every
provision creates a private temporary directory, an optional Git worktree
staging area, and a dedicated OCI container.

## Lifecycle

```ts
const host = new DockerExecutionHost();
const executionId = ExecutionId(crypto.randomUUID());

const execution = await host.provision({
  executionId,
  image: 'registry.example.com/agent@sha256:<digest>',
  workspace: {
    kind: 'git-worktree',
    repositoryPath: '/srv/repositories/project',
    revision: 'main',
  },
  resources: {
    cpus: 2,
    memoryBytes: 4 * 1024 ** 3,
    diskBytes: 10 * 1024 ** 3,
    pids: 256,
    runtimeMs: 30 * 60_000,
    maxOutputBytes: 8 * 1024 ** 2,
  },
  network: { mode: 'none' },
});

const result = await host.exec(execution.executionId, {
  command: '/bin/sh',
  args: ['-c', 'npm test'],
  timeoutMs: 10 * 60_000,
});

const checkpoint = await host.checkpoint(execution.executionId, {
  reason: 'handoff',
});
await host.terminate(execution.executionId);

const restored = await host.restore({
  checkpointId: checkpoint.checkpointId,
});
```

`terminate()` is idempotent. A command timeout, output overflow, or abort
destroys the complete container instead of only killing the local
`docker exec` client.

## Isolation boundary

Every `ExecutionResourceLimits` field is mandatory:

| Resource | Enforcement |
|----------|-------------|
| CPU | Docker `NanoCpus` |
| Memory | `Memory` and an equal `MemorySwap` value |
| Disk | `/workspace`, `/tmp`, and `/dev/shm` split from one bounded tmpfs budget |
| PIDs | `PidsLimit` |
| Runtime | host deadline, in-container self-termination, and `--rm` |
| Output | combined stdout/stderr byte limit |
| Network | `none` by default; proxy mode accepts only an isolated network from `ExecutionEgressController` |

The container also uses a read-only root filesystem,
`no-new-privileges`, a numeric non-root user, and `cap-drop=ALL`. The
host does not add any capability back. Before provision succeeds, it reads
Docker `inspect` and fails closed unless every requested control is active.

Images must use immutable `sha256` digests by default. The reference host
requires `/bin/sh`, `sleep`, `cat`, `rm`, and `tar` in the image. Provision
rejects image environment variables that appear to contain long-lived
credentials.

The Git worktree is temporary host-side staging. After copying files into the
bounded tmpfs, the host removes the worktree `.git` control file from the
container to avoid exposing host repository paths. It removes the host
worktree before provision returns. The container workspace is therefore an
isolated revision snapshot, not a writable host repository mount.

## Network egress

`none` provides complete network isolation. `proxy` mode requires an injected
controller:

```ts
const egressController: ExecutionEgressController = {
  async provision(executionId, policy) {
    const networkName = await createIsolatedProxyNetwork(
      executionId,
      policy.allowedHosts,
    );
    return {
      networkName,
      environment: {
        HTTPS_PROXY: 'http://proxy.internal:8080',
      },
    };
  },
  async release(executionId) {
    await removeIsolatedProxyNetwork(executionId);
  },
};
```

`DockerExecutionHost` validates and attaches the dedicated network returned by
the controller. The controller owns DNS, IP, TLS, and CONNECT enforcement for
the hostname allowlist. Reserved networks such as `none`, `host`, and
`bridge` cannot satisfy a proxy lease. Proxy URLs cannot embed a username or
password.

## Ephemeral credentials

Do not pass long-lived secrets through provision or regular exec
environments. Use `CredentialBroker` to issue a credential for one command:

```ts
const credentialBroker = new EphemeralCredentialBroker({
  github: {
    environmentVariable: 'GITHUB_EPHEMERAL_TOKEN',
    async issue({ audience, scopes, expiresBy }) {
      return issueGitHubToken({ audience, scopes, expiresBy });
    },
  },
});

const host = new DockerExecutionHost({ credentialBroker });
await host.exec(executionId, {
  command: 'git',
  args: ['fetch', 'origin'],
  credentials: [{
    name: 'github',
    audience: 'github.com',
    scopes: ['contents:read'],
  }],
});
```

The issuer fixes the environment variable name; the caller cannot select it.
The value enters only the child environment for one `docker exec`. It is
absent from CLI arguments, container configuration, checkpoints, and the
long-lived Agent environment. Captured stdout and stderr redact the raw value.
The broker revokes credentials after the command or lease expiry and rejects
credentials that outlive the requested TTL.

## Checkpoint boundary

The Docker host pauses the primary container, copies the workspace volume
through the Docker daemon, and writes a versioned manifest. Restore runs the
complete provision validation again before loading the workspace through a
bounded tar stream into a new container. A checkpoint contains no process,
memory, network connection, or credential state.

The default checkpoint directory is local and supports single-host recovery
and handoff. Cross-worker scheduling needs a shared `ExecutionHost`
implementation or controlled checkpoint upload to object storage. A local
checkpoint ID is not a distributed source of truth.
