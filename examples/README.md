# Golden Paths

These examples exercise the public package entrypoints after `pnpm run build`.

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
