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
→ AgentWorker
→ DockerExecutionHost
→ PostgreSQL event log
→ SSE
```

Run the non-interactive acceptance check with:

```bash
pnpm run build
pnpm verify:production-example
```

The reported `firstResultMs` starts before infrastructure orchestration. The
smoke command succeeds only after receiving the exact Docker worker output
within five minutes.

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
