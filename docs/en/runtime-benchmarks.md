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

Each run creates an isolated schema and drops it on completion. The command
prints JSON so CI or a historical metrics collector can retain and compare it.

Run the complete CI regression gate with:

```bash
TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/blade_agent_test \
TEST_DOCKER_IMAGE=alpine@sha256:... \
  pnpm verify:runtime-regression
```

This command runs the steady-state benchmark and a real Docker checkpoint
failover. It writes
`artifacts/runtime-regression.json` and applies
[`benchmarks/runtime-regression-policy.json`](https://github.com/echoVic/blade-agent-sdk/blob/main/benchmarks/runtime-regression-policy.json).
PR CI retains the report for 30 days; Release CI retains it for 90 days.

## Metric definitions

| Metric | Definition |
|--------|------------|
| `storeInitializationMs` | Time to create and migrate a new Runtime Store schema |
| `firstClaimLatencyMs` | Time from `AgentWorker.start()` to the first Session claim |
| `sessionThroughputPerSecond` | Session claim, transition, and lease-release throughput without model latency |
| `recoveryDurationMs` | Time to recover and reclaim a Session after its lease is known to be expired |
| `eventLossRate` | Difference between written events and cursor-paginated reads; a sequence gap also produces `1` |
| `processTerminationMs` | Time from sending `SIGKILL` until Worker process exit is observed |
| `leaseExpiryWaitMs` | Time from process exit until the database lease expires |
| `failureDetectionMs` | Time from `SIGKILL` until the recovery scan identifies the expired owner |
| `recoveryScanMs` | Duration of the PostgreSQL recovery transaction |
| `reclaimAndRestoreMs` | Time from recovery completion until Worker B restores the checkpoint and completes the Session |
| `checkpointRestoreMs` | Isolated `DockerExecutionHost.restore()` duration |
| `fullRecoveryRtoMs` | Time from `SIGKILL` until the recovered Session completes; this is the complete RTO |

Session throughput is a Runtime upper-bound test and excludes model or external
tool latency. `recoveryDurationMs` excludes the wait for the lease TTL itself.
Capacity and recovery planning must use `fullRecoveryRtoMs`, not the legacy
`recoveryDurationMs`.

## CI gates

CI requires at least `100` Sessions and `1000` events, plus the complete Docker
checkpoint failover:

Current absolute thresholds:

- Session throughput is at least `20 sessions/s`; 100 Sessions complete within
  `10s`.
- Complete Docker failover RTO is at most `15s`, including failure detection
  within `3.5s` and checkpoint restore within `5s`.
- Event loss is exactly `0`.

These are intentionally broad absolute guardrails across CI runners, not
machine-to-machine microbenchmark comparisons. Threshold changes require a
reviewed policy update; sample counts cannot be reduced to bypass a gate.

## 2026-08-26 baseline

Environment:

```text
Node.js v22.23.1
macOS Darwin 25.5.0
PostgreSQL 16.15 (Colima)
100 Sessions / 1000 events
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

Release regression gates:

- The historical JSON above is a development-machine baseline, not the sole CI
  criterion.
- CI applies the versioned absolute policy and retains one artifact containing
  raw source reports, per-check results, and environment metadata.
