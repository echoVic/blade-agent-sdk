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

The browser uses `AgentClient`; the Node process hosts `AgentServer` with
`JsonlAgentServerStore` and `JsonlSessionRepository` under `.blade/`. Without
`OPENAI_API_KEY` a scripted provider drives the same real tools; with a key the
model does. `OPENAI_BASE_URL` selects any OpenAI-compatible endpoint.

The page is a timeline: thinking, tool cards with status and output, approval
cards, steering chips and the streamed answer. Ask **Analyze this project's
dependency risks**, then type **Focus on security issues** while it runs; the
input is inserted with priority `now`. Stop and restart the server, refresh, and
ask **Continue the analysis**: the session record, event log and transcript come
back from disk. Pass `--root <dir>` to analyze another repository and
`--no-open` to keep the browser closed.

Tools are Read, Glob, Grep and Bash. When an OS sandbox works (macOS seatbelt,
Linux bubblewrap) Bash runs inside it and is auto-approved; otherwise each
command is an approval card. Destructive commands always ask.

`node examples/web-agent-server/server.mjs --smoke` runs the nine steps with the
scripted provider: tools, steering, a simulated restart with a fresh store and
server on the same data directory, and a continued session.

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
