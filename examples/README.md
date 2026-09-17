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

Open <http://127.0.0.1:8787>. The browser uses `AgentClient`; the Node process
hosts `AgentServer`. The example uses a deterministic local provider when
`OPENAI_API_KEY` is absent and a real OpenAI model when it is present.

The page supports consecutive turns, cancellation, and reconnecting without
duplicating streamed text. It saves the displayed conversation, active request,
and event cursor in this tab's `sessionStorage`, so refreshing the page also
resumes an in-progress response. `Cancel` waits for the server to acknowledge
cancellation; `Reconnect` continues the same request after connection retries
are exhausted. `New session` starts a fresh conversation once the current
request settles.

This Web preset keeps server Sessions in memory. Page refresh recovery lasts
only while the same server process still has the Session; restarting the server
shows an unavailable-session message and lets you start again. Closing the tab
also ends its saved browser view. An expired event cursor preserves the saved
text and offers a new session instead of silently dropping missing output.

After building, run `node examples/web-agent-server/server.mjs --smoke` to verify
multiple turns, cursor reconnect, history recovery, and cancellation. Smoke
always uses the deterministic provider, even if an API key is configured.

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
