# Runtime 基准

本页记录可复现的 Runtime 基准，不代表任何部署环境的 SLA。结果必须与测试环境、
样本数和运行命令一起发布。

## 运行

准备一个可清理的 PostgreSQL 数据库，然后执行：

```bash
TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/blade_agent_test \
  pnpm benchmark:runtime
```

可通过以下环境变量调整样本数：

- `BENCHMARK_SESSIONS`，默认 `100`
- `BENCHMARK_EVENTS`，默认 `1000`
- `BENCHMARK_EFFECTS`，默认 `100`

脚本为每次运行创建独立 schema，并在结束时删除。它输出 JSON，CI 或历史采集器
可以直接保存和比较结果。

完整 CI 回归门禁：

```bash
TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/blade_agent_test \
TEST_DOCKER_IMAGE=alpine@sha256:... \
  pnpm verify:runtime-regression
```

该命令执行稳态 benchmark、真实 Docker checkpoint failover 和四点 `SIGKILL`
fault matrix，写入 `artifacts/runtime-regression.json`，再应用
[`benchmarks/runtime-regression-policy.json`](https://github.com/echoVic/blade-agent-sdk/blob/main/benchmarks/runtime-regression-policy.json)。
PR CI 保留报告 30 天，Release CI 保留 90 天。

## 指标定义

| 指标 | 定义 |
|------|------|
| `storeInitializationMs` | 创建并迁移一个全新 Runtime Store schema 的耗时 |
| `firstClaimLatencyMs` | `AgentWorker.start()` 到首次领取 Session 的耗时 |
| `sessionThroughputPerSecond` | 无模型延迟的 Session claim、状态转换和 lease 释放吞吐 |
| `recoveryDurationMs` | 已确认 lease 过期后，执行恢复扫描并由第二个 worker 领取的耗时 |
| `eventLossRate` | 写入事件数与按 cursor 分页读回事数量之差占比；sequence 不连续也记为 `1` |
| `nonIdempotentDuplicateRate` | 两个 dispatcher 并发消费时，at-most-once effect 的重复 handler 调用占比 |
| `processTerminationMs` | 发出 `SIGKILL` 到观察到 Worker 进程退出 |
| `leaseExpiryWaitMs` | 进程退出到数据库 lease 到期 |
| `failureDetectionMs` | 发出 `SIGKILL` 到 recovery scan 完成并识别失效 owner |
| `recoveryScanMs` | PostgreSQL recovery transaction 本身耗时 |
| `reclaimAndRestoreMs` | recovery scan 完成到第二个 Worker 恢复 checkpoint 并完成 Session |
| `checkpointRestoreMs` | `DockerExecutionHost.restore()` 的独立耗时 |
| `fullRecoveryRtoMs` | 发出 `SIGKILL` 到恢复后的 Session 完成；这是完整 RTO |
| `faultInjectionPassRate` | 四个 crash point 的期望执行次数与终态全部匹配的比例 |
| `faultInjectionDuplicateRate` | fault matrix 中超出期望次数的非幂等 effect 执行占比 |
| `maximumFaultRecoveryRtoMs` | 四个 effect crash point 中最慢的 kill-to-settlement 耗时 |

Session throughput 是运行时上限测试，不包含模型或外部工具延迟。
`recoveryDurationMs` 不包含等待 lease TTL 到期的时间。
容量规划和故障恢复应使用 `fullRecoveryRtoMs`，而不是旧的
`recoveryDurationMs`。

## CI 门禁

CI 固定使用至少 `100` 个 Session、`1000` 个 event、`100` 个 effect，以及
全部四个 crash point：

| Crash point | 期望执行次数 | 期望终态 |
|-------------|-------------|---------|
| `after_claim` | `1` | `completed` |
| `after_start` | `0` | `uncertain` |
| `after_side_effect` | `1` | `uncertain` |
| `after_complete` | `1` | `completed` |

当前绝对阈值：

- Session throughput 不低于 `20 sessions/s`；100 个 Session 在 `10s` 内完成。
- 完整 Docker failover RTO 不超过 `15s`，其中 failure detection 不超过
  `3.5s`、checkpoint restore 不超过 `5s`。
- 每个 effect fault point 的 kill-to-settlement RTO 不超过 `5s`。
- event loss、正常并发重复和 fault-injection 重复率都必须严格为 `0`。
- fault matrix pass rate 必须为 `1`。

这些是跨 CI runner 的宽松绝对 guardrail，不把不同机器上的微基准差异误判为
回归。调整阈值必须修改版本化 policy 并接受代码审查；不能通过降低样本数绕过。

## 2026-08-26 基线

环境：

```text
Node.js v22.23.1
macOS Darwin 25.5.0
PostgreSQL 16.15（Colima）
100 Sessions / 1000 events / 100 effects
```

结果：

原始 JSON：
[`benchmarks/baselines/2026-08-26-darwin-arm64.json`](https://github.com/echoVic/blade-agent-sdk/blob/main/benchmarks/baselines/2026-08-26-darwin-arm64.json)

| 指标 | 结果 |
|------|------|
| Runtime Store 初始化 | `77.04 ms` |
| 首次 Session claim | `13 ms` |
| Session 吞吐 | `106.48 sessions/s` |
| 100 个 Session 完成耗时 | `939.16 ms` |
| Worker 恢复与重新领取 | `14.67 ms` |
| 事件丢失率 | `0` |
| 非幂等 effect 重复率 | `0` |

发布回归门槛：

- 上述历史 JSON 是开发机基线，不是 CI 的唯一判据。
- CI 使用版本化绝对 policy，并保留包含原始子报告、逐项 check 和环境信息的
  完整 artifact。
