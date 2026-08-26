# Runtime Benchmarks

This page records reproducible Runtime benchmarks. Results are not deployment
SLAs and must be published together with the environment, sample sizes, and
command used.

## Run

Prepare a disposable PostgreSQL database, then run:

```bash
TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/blade_agent_test \
  pnpm benchmark:runtime
```

The sample sizes are configurable:

- `BENCHMARK_SESSIONS`, default `100`
- `BENCHMARK_EVENTS`, default `1000`
- `BENCHMARK_EFFECTS`, default `100`

Each run creates an isolated schema and drops it on completion. The command
prints JSON so CI or a historical metrics collector can retain and compare it.

## Metric definitions

| Metric | Definition |
|--------|------------|
| `storeInitializationMs` | Time to create and migrate a new Runtime Store schema |
| `firstClaimLatencyMs` | Time from `AgentWorker.start()` to the first Session claim |
| `sessionThroughputPerSecond` | Session claim, transition, and lease-release throughput without model latency |
| `recoveryDurationMs` | Time to recover and reclaim a Session after its lease is known to be expired |
| `eventLossRate` | Difference between written events and cursor-paginated reads; a sequence gap also produces `1` |
| `nonIdempotentDuplicateRate` | Duplicate at-most-once handler invocations with two concurrent dispatchers |

Session throughput is a Runtime upper-bound test and excludes model or external
tool latency. `recoveryDurationMs` excludes the wait for the lease TTL itself.

## 2026-08-26 baseline

Environment:

```text
Node.js v22.23.1
macOS Darwin 25.5.0
PostgreSQL 16.15 (Colima)
100 Sessions / 1000 events / 100 effects
```

Results:

Raw JSON:
[`benchmarks/baselines/2026-08-26-darwin-arm64.json`](https://github.com/echoVic/blade-agent-sdk/blob/main/benchmarks/baselines/2026-08-26-darwin-arm64.json)

| Metric | Result |
|--------|--------|
| Runtime Store initialization | `77.04 ms` |
| First Session claim | `13 ms` |
| Session throughput | `106.48 sessions/s` |
| 100 Session completion time | `939.16 ms` |
| Worker recovery and reclaim | `14.67 ms` |
| Event loss rate | `0` |
| Non-idempotent effect duplicate rate | `0` |

Release regression gates:

- `eventLossRate` must be `0`.
- `nonIdempotentDuplicateRate` must be `0`.
- Performance results must retain raw JSON and environment data. Results from
  different machines are not directly comparable.
