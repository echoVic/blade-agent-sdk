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

## 指标定义

| 指标 | 定义 |
|------|------|
| `storeInitializationMs` | 创建并迁移一个全新 Runtime Store schema 的耗时 |
| `firstClaimLatencyMs` | `AgentWorker.start()` 到首次领取 Session 的耗时 |
| `sessionThroughputPerSecond` | 无模型延迟的 Session claim、状态转换和 lease 释放吞吐 |
| `recoveryDurationMs` | 已确认 lease 过期后，执行恢复扫描并由第二个 worker 领取的耗时 |
| `eventLossRate` | 写入事件数与按 cursor 分页读回事数量之差占比；sequence 不连续也记为 `1` |
| `nonIdempotentDuplicateRate` | 两个 dispatcher 并发消费时，at-most-once effect 的重复 handler 调用占比 |

Session throughput 是运行时上限测试，不包含模型或外部工具延迟。
`recoveryDurationMs` 不包含等待 lease TTL 到期的时间。

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

- `eventLossRate` 必须为 `0`。
- `nonIdempotentDuplicateRate` 必须为 `0`。
- 性能指标必须保留原始 JSON 和环境信息；跨机器结果不能直接比较。
