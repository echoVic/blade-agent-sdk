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
route, executes the prompt in a network-disabled Docker container, and publishes
the result through the durable SSE event log. `Ctrl+C` removes the PostgreSQL
container, execution containers, volumes, and temporary files.

For a non-interactive end-to-end check:

```bash
pnpm run build
pnpm verify:production-example
```

The smoke command prints `firstResultMs` and fails unless the browser protocol
receives the exact output produced by the Docker worker within five minutes.

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
