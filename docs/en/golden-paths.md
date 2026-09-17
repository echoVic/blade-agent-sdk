# Golden Paths

The repository provides four runnable paths. Every example imports only public
package entrypoints.

## Single-command production loop

```bash
pnpm example:production
```

Open the local URL printed by the command. It starts PostgreSQL and cleans up
PostgreSQL, worker-created Docker containers, volumes, and temporary files on
exit. Each request traverses the complete path:

```text
Browser AgentClient
→ AgentServer
→ PostgreSQL route queue
→ AgentWorker + SDK Session
→ Docker repository tools
→ PostgreSQL event log
→ SSE
```

Run the non-interactive acceptance check with:

```bash
pnpm run build
pnpm verify:production-example
```

The reported `firstResultMs` starts before infrastructure orchestration. The
smoke command succeeds only after the repository tests pass within five minutes.
It reads the fixture, approves an edit, kills the Worker after the edit is
checkpointed, reconnects SSE, and verifies that a new Worker completes the task
with a higher fencing token. It also checks a Worker crash while approval is pending, a second turn, denied
writes, and cancellation followed by a new task.

Try: **Fix the greeting to say Hello, Blade! and run the tests.** The browser
shows the proposed edit before you choose **Approve once** or **Deny**. Tool
progress, test output, and the final answer appear in the conversation.
Without an API key, a deterministic adapter drives real SDK tool calls. Set
`OPENAI_API_KEY` and optionally `OPENAI_MODEL` to use a model; `--smoke` always
uses the deterministic adapter.

The example works on a disposable Git fixture, with two readable files, one
writable source file, and a fixed test command. `RepositoryTools.mjs` is the
extension point for another repository. The model runs in the Worker; file and
test operations run inside a network-disabled Docker container. Transcripts,
approvals, cancellation intent, and workspace checkpoints survive Worker
restarts while the launcher stays running. The launcher automatically starts a
successor when its Worker exits unexpectedly. Stopping the launcher deletes its
temporary database and checkpoints.

The launcher keeps no in-process recovery cache: it reads the route state,
fencing token, and committed workspace checkpoint from PostgreSQL, so a successor
process observes the same recovery boundary.

Recovery is limited to outcomes the example can verify. File replacement uses
expected-content checks and checkpoints before reporting success. An interrupted
test command with an unknown outcome stops for reconciliation. The example uses
one API process and does not guarantee API failover or exactly-once arbitrary
tool execution.

The same smoke verifies the successor Worker's local readiness snapshot.
Acceptance passes only when the recovered Worker is ready.

## Generate a standalone project

The published SDK includes the `create-blade-agent` executable. Select the
required topology with `--preset`:

| Preset | Path | Extra infrastructure | First-result budget |
|--------|------|----------------------|---------------------|
| `local` | Node + in-memory Session | None | 1 minute |
| `web` | Browser AgentClient → AgentServer → in-process Session | None | 2 minutes |
| `production` | Browser → AgentServer → PostgreSQL → Worker → Docker | Docker | 5 minutes |

Minimal local Agent:

```bash
npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --preset local --verify
```

Web Agent:

```bash
npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --preset web --verify
```

Complete production topology:

```bash
npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --preset production --verify
```

Each budget starts with the CLI and covers generation, installation, and the
first real smoke result. PR and Release CI install the CLI from the current SDK
tarball, run all three presets, and audit every generated production dependency
tree. Omitting `--preset` generates the default `local` starter. Omit `--verify` to
avoid running the smoke; `--skip-install` writes files only.

## Local CLI Agent

```bash
BLADE_DEMO_MODE=mock pnpm example:local -- "Inspect this repository"
```

Use a real OpenAI model:

```bash
OPENAI_API_KEY=... pnpm example:local -- "Inspect this repository"
```

This path covers the Node runtime profile, built-in tools, streaming output,
and local JSONL persistence.

## Web + AgentServer

```bash
pnpm example:web
```

Open <http://127.0.0.1:8787>. Browser code uses `AgentClient`; the server uses
`AgentServer` through its Fetch-compatible handler. The example uses a
deterministic local provider when `OPENAI_API_KEY` is absent and real OpenAI
when it is present.

The page supports consecutive turns, cancellation, and reconnecting without
duplicating streamed text. This tab's `sessionStorage` saves the displayed
conversation, active request, and event cursor together; refreshing also resumes
an in-progress response. `Cancel` waits for server acknowledgement. `Reconnect`
continues the same request after connection retries are exhausted, and
`New session` starts a fresh conversation after the current request settles.

Server Sessions in this Web preset are in memory: refresh recovery requires the
same server process to remain running. If the Session is lost after a restart or
the cursor expires, the page preserves saved text and offers a new session.
Closing the tab ends its saved browser view. This is not persistence across
server restarts.

After building, `node examples/web-agent-server/server.mjs --smoke` verifies
multiple turns, cursor reconnect, history recovery, and cancellation. Smoke
always uses the deterministic provider, even when an API key is configured.

## PostgreSQL + Two Workers + Docker Recovery

```bash
pnpm example:worker-recovery
```

This path:

1. Starts an isolated PostgreSQL instance.
2. Lets Worker A write state in a Docker workspace and persist a checkpoint.
3. Sends `SIGKILL` to Worker A.
4. Waits for lease expiry and runs recovery.
5. Lets Worker B restore the checkpoint with a higher fencing token.
6. Verifies the workspace and completes the Session.
7. Removes PostgreSQL, containers, volumes, and temporary files.

Docker must be installed. The complete sources live under
[`examples/`](https://github.com/echoVic/blade-agent-sdk/tree/main/examples).
