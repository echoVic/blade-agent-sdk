# Migrating to your own repository

The [`production` example](https://github.com/echoVic/blade-agent-sdk/tree/main/examples/production-stack) runs a complete
read → approve → edit → test workflow against a disposable Git fixture, and its
smoke verifies approval, denial, recovery after the Worker is SIGKILLed, SSE
reconnection, and cancellation. This page explains what to change when you move
that workflow onto your repository, your sign-in system, and your retention
policy.

Read the production section of [Golden Paths](./golden-paths) first, and confirm
`pnpm verify:production-example` passes locally.

## Understand the example's security model first

The example keeps its capabilities deliberately narrow. That is the point of the
layer, not a demo shortcut: every tool in `RepositoryTools.mjs` constrains model
input to argv or stdin, while the programs themselves are fixed strings.

| Mechanism | What the example does | Why keep it |
|-----------|----------------------|-------------|
| Path allowlist | `RepoRead` accepts only `src/greeting.sh` and `test/greeting.test.sh` | The model cannot name a path outside the list, and symlinks are rejected explicitly |
| Pre-write check | `RepoWrite` requires `expected_content` to match the file byte for byte | Prevents overwriting someone else's commit — an optimistic lock |
| Trusted tests | `RepoRunTests` compares the test file with the expected content before running it | Otherwise the model could edit tests to make them pass |
| No network | The Docker container starts with `mode: 'none'` | Repository code cannot reach the network |

The usual migration mistake is relaxing these rules to make the example "work
with my repository". Map them onto your real constraints first, then widen.

## What the SDK owns, and what you own

The production starter copies the example modules into your project, so it helps
to know where the boundary sits: the recovery semantics come from the SDK, and
the copied code only encodes your repository policy. Do not re-implement the
guarantees the SDK already provides.

| Concern | Owner | Notes |
|---------|-------|-------|
| Route queue, Session lease, fencing token | SDK | `AgentServer` + `AgentWorker` + Runtime Store |
| Post-crash recovery plan (model outcome, tool outcomes, pending approvals) | SDK | `DurableSessionRecoveryCoordinator`; the example only supplies the policy in `RepositoryRecovery.mjs` |
| Workspace checkpoints and restore | SDK | `DockerExecutionHost` `checkpoint` / `restore` / `reclaim` |
| Crash boundary and recovery state | PostgreSQL | The launcher caches none of it: route state, fencing token, and the committed checkpoint are read from the store |
| Submission and terminal-event reconciliation | Your project | `RepositoryState.mjs` + `RepositoryReconcile.mjs` are your own queue tables and catch-up policy |
| Tool allowlists and approval policy | Your project | `RepositoryTools.mjs` and the approval records in `RepositoryState.mjs` |
| Smoke assertions | Your project | `smoke.mjs` asserts against the example fixture; rewrite it for your repository |

`RepositoryDemoProvider.mjs` only serves the smoke run's deterministic model
output and can be deleted once you use a real model.

## Step 1: Point it at your repository

The example copies a fixture into a temporary Git repository at startup. Replace
that block in `run.mjs`:

```js
// Before: copy a disposable fixture
const repositoryPath = join(temporaryRoot, 'repository');
await cp(join(root, 'fixture'), repositoryPath, { recursive: true });
await execFileAsync('git', ['init', '--quiet', repositoryPath]);

// After: clone a real repository; never run the Agent on a working copy
const repositoryPath = join(temporaryRoot, 'repository');
await execFileAsync('git', ['clone', '--quiet', '--depth', '1',
  process.env.AGENT_REPOSITORY_URL, repositoryPath]);
```

Keep in mind:

- **Always run the Agent on a clone or worktree**, never on a developer's working
  copy. Checkpoint recovery replaces file content, so a working copy would lose
  local changes.
- Use a deploy key or short-lived credential for private repositories. That
  credential is only for `git clone`; keep it out of the container environment.
- To pin a revision, run `git -C <dir> checkout <sha>` after cloning and record
  that SHA, so you can tell later exactly what the Agent changed.

## Step 2: Rewrite the tool allowlists

All three fixed programs in `RepositoryTools.mjs` need to match your repository:

1. The `case` branches in `READ_FILE`: list the paths the Agent may read. Reading
   an entire repository is rarely realistic; start with the files it actually
   needs, such as build scripts, target sources, and configuration.
2. The first check in `WRITE_FILE`: replace `test "$1" = src/greeting.sh` with
   your writable path set. Allow source files only and keep test files and CI
   configuration out of it.
3. `RUN_TESTS`: replace `sh test/greeting.test.sh` with your real test command and
   keep the content comparison that precedes it.

Once the allowlist grows, read it from one place instead of scattering it through
shell strings:

```js
const allowedWrites = new Set(['packages/api/src/handler.ts', 'packages/api/src/schema.ts']);
const allowedReads = new Set([...allowedWrites, 'package.json', 'pnpm-lock.yaml']);
```

Update the tool descriptions too, or the model will keep guessing at the example's
paths:

```js
defineTool({
  name: 'RepoWrite',
  description: 'Replace an allowed source file after approval.',
  // ...
});
```

## Step 3: Connect your own sign-in

The example authenticates with a single shared token:

```js
authenticate(request) {
  if (request.headers.get('authorization') !== 'Bearer local-demo') return null;
  return { tenantId, subject: 'browser-user', scopes: ['session:admin'] };
}
```

The principal returned by `authenticate` decides three things: `tenantId` isolates
storage and events, `subject` participates in approval isolation, and `scopes`
authorize commands. Keep that shape when you plug in real authentication:

```js
authenticate(request) {
  const claims = await verifySessionCookie(request.headers.get('cookie'));
  if (!claims) return null;
  return {
    tenantId: claims.organizationId,
    subject: claims.userId,
    scopes: scopesForRole(claims.role),
  };
}
```

Boundaries worth knowing:

- **Do not hand `session:admin` to ordinary users.** It satisfies every scope.
  Split it by role into `session:create`, `session:read`, `session:write`, and
  `permission:resolve` (`session.fork` needs both `session:read` and
  `session:create`).
- **Approvals are isolated by tenant, Session, `subject`, and
  `permissionRequestId`.** If a different person clicks Approve in the same
  Session, the request does not resolve. That is intentional.
- Cross-tenant access always returns `SESSION_NOT_FOUND` instead of disclosing
  whether the Session exists, so do not debug it as a missing Session.

## Step 4: Decide retention

The example deletes its temporary database and checkpoints on exit. Production is
the opposite: decide what you keep and for how long.

| Data | Example behavior | Production guidance |
|------|------------------|---------------------|
| Routes, events, approvals, transcripts | PostgreSQL, removed with the container | A dedicated instance with backups; partition event tables by time |
| Workspace checkpoints | Local `checkpointDirectory` | Shared storage or controlled object storage, or cross-host recovery fails |
| The Agent's Git changes | Left in the temporary repository | Have the Agent push a branch or emit a patch for review before merge |
| Docker workspace volumes | Removed with the container | Do not retain: cheap to rebuild and prone to leaving sensitive content behind |

The PostgreSQL schema version is `3` and `initialize()` migrates under a global
advisory lock. Read the schema section of [Runtime Store](./runtime-store) before
upgrading the SDK.

Local checkpoints only restore on the same host. Multi-replica deployments need a
shared `ExecutionHost` implementation or controlled checkpoint upload; treating a
local checkpoint ID as a distributed source of truth fails as soon as recovery
lands on another machine.

## Step 5: From smoke to real use

`smoke.mjs` currently asserts the fixture's fixed output
(`Tests passed (exit 0).`). That will fail against a real repository, which is
useful: it tells you the acceptance criteria changed. Suggested path:

1. Keep the smoke's **flow assertions** (approval happens, recovery after the
   Worker is killed, SSE reconnection, cancellation works) and replace the
   **content assertion** with your own verdict, such as "the named test file goes
   from red to green".
2. Run `--smoke` first with the deterministic provider to validate the wiring, then
   set `OPENAI_API_KEY` to switch to a real model.
3. Be explicit about one limitation before launch: the example runs a single API
   process and **provides neither API failover nor exactly-once arbitrary tool
   execution**. When a test run is interrupted with an unknown outcome, stop and
   reconcile instead of retrying automatically.

## Migration checklist

- [ ] The Agent runs on a clone or worktree, not a developer's working copy
- [ ] Read and write allowlists cover the real paths; tests and CI config stay unwritable
- [ ] The test command comes from a trusted source and still gets a content comparison
- [ ] Container network stays `mode: 'none'` unless egress is genuinely required
- [ ] `authenticate` returns real `tenantId` / `subject` / minimal `scopes`
- [ ] Checkpoint storage works across hosts, or single-host recovery is stated explicitly
- [ ] Smoke assertions are rewritten for your repository and run regularly in CI
- [ ] There is a reconciliation path for unknown outcomes that does not rely on automatic retries
