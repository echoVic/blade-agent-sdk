# Golden Paths

These examples exercise the public package entrypoints after `pnpm run build`.

## Complete production stack

```bash
pnpm example:production
```

Open the printed local URL. One command starts PostgreSQL and a Node control
plane, then connects the browser through this complete path:

```text
AgentClient -> AgentServer -> PostgreSQL -> AgentWorker -> DockerExecutionHost
```

The control plane only persists and queues requests. `AgentWorker` claims each
route and runs a real SDK Session. The Agent reads `src/greeting.sh`, requests
write approval in the browser, edits the isolated repository, and runs its shell
tests through Docker tools. Results stream through the durable SSE event log.
Try: **Fix the greeting to say Hello, Blade! and run the tests.**

Without an API key, a deterministic model adapter drives the same real tools.
Set `OPENAI_API_KEY` and optionally `OPENAI_MODEL` for model-driven tasks.
`--smoke` always uses the deterministic adapter. Model calls stay in the Worker;
Docker tools have no network access. The fixture allows two read paths, one
write path, and a fixed test command; extend `RepositoryTools.mjs` for another
repository.

Each edit is checkpointed before the tool reports success. PostgreSQL keeps
transcripts, approvals, cancellation intent and runtime events; Worker restarts
can recover a saved edit and continue the conversation. Interrupted test
commands with unknown outcomes require reconciliation. This example uses one
API process and temporary infrastructure; it does not implement API failover or
exactly-once arbitrary tools. `Ctrl+C` removes the PostgreSQL
container, execution containers, volumes, and temporary files.

For a non-interactive end-to-end check:

```bash
pnpm run build
pnpm verify:production-example
```

The smoke command prints `firstResultMs` and fails unless the browser protocol
receives passing test results within five minutes. It exercises approval, a
real Worker SIGKILL after a saved edit, cursor-based SSE reconnection, a second
turn using the saved workspace, denial, and cancellation followed by another
task. It also verifies the replacement Worker's local readiness snapshot.
Exiting the launcher removes the temporary database and checkpoints.

Generate any Golden Path as an independent project from the published package:

```bash
npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --preset local --verify

npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --preset web --verify

npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --preset production --verify
```

The CLI installs the generated dependencies and includes setup time in each
first-result budget: one minute for local, two minutes for Web, and five minutes
for production. Omitting `--preset` generates the default `local` starter.

## Local CLI Agent

```bash
OPENAI_API_KEY=... pnpm example:local -- "Inspect this repository"
```

The example uses the Node runtime profile, local tools, streaming output, and a
crash-safe JSONL session store under `.data/local-cli-agent`.
For an offline smoke test, run:

```bash
BLADE_DEMO_MODE=mock pnpm example:local -- "Hello"
```

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

Docker must be running.

```bash
pnpm example:worker-recovery
```

The script starts an isolated PostgreSQL container, runs Worker A until it has
persisted a Docker workspace checkpoint, kills Worker A, expires its lease, and
starts Worker B. Worker B restores the checkpoint and verifies its contents.
All containers and temporary files created by the example are removed before
the command exits.
