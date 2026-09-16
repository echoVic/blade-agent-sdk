# Execution Host

`ExecutionHost` is the stable boundary between a scheduler and a task
environment. Server code depends only on `provision`, `exec`, `checkpoint`,
`restore`, and `terminate`, without coupling to containers, virtual machines,
or remote workers.

```ts
import {
  DockerExecutionHost,
  type ExecutionHost,
  ExecutionId,
} from '@blade-ai/agent-sdk/advanced';
```

`DockerExecutionHost` is the Node.js reference implementation. Every provision
creates a private, bounded tmpfs workspace and a dedicated OCI container. The
workspace may start empty or import one local Git revision.

The reference implementation has explicit internal owners:
`DockerExecutionPolicy` validates requests and builds container configuration,
`DockerProcessRunner` enforces process timeouts, cancellation, and output
limits, and `DockerWorkspace` transfers Git archives and checkpoint workspaces.
`DockerExecutionHost` retains only execution lifecycle and ownership state.

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
| Disk | A `/workspace` tmpfs bounded by `diskBytes` |
| PIDs | `PidsLimit` |
| Runtime | Host deadline, in-container `sleep` deadline, and `--rm` |
| Output | combined stdout/stderr byte limit |
| Network | The Docker reference host accepts only `mode: 'none'` |

The container also uses a read-only root filesystem,
`no-new-privileges`, a numeric non-root user, and `cap-drop=ALL`. The
host does not add any capability back.

Images must use immutable `sha256` digests by default. The reference host
requires `/bin/sh`, `sleep`, and `tar` in the image.

Git workspaces use `git archive` to read the requested revision and unpack it
as the container's non-root user. The host creates no worktree, copies no
`.git` data, and never bind-mounts the host repository.

## Network egress

`DockerExecutionHost` supports only fully isolated `mode: 'none'`. Implement a
separate application execution boundary when proxy or hostname allowlisting is
required; the SDK `ExecutionHost` contract does not declare that capability,
and the reference host never silently falls back to an ordinary Docker
network. Ordinary environment variable names may not appear to contain a token,
secret, password, API key, or credential.

## Checkpoint boundary

The Docker host uses the execution mutex to prevent checkpoint and exec from
overlapping, copies the workspace through the Docker daemon, and writes a
schema-validated versioned manifest. Restore runs complete provision validation
before loading the workspace through a bounded tar stream into a new container.
A checkpoint contains no process, memory, network connection, or credential
state.

Checkpoints live in the local `checkpointDirectory` by default and support
single-host recovery and handoff. Cross-worker scheduling needs a shared
`ExecutionHost` implementation or controlled checkpoint upload to object
storage. A local checkpoint ID is not a distributed source of truth.
