# Web Preset 首跑体验（9 步流程）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `npx create-blade-agent demo --preset web` 在 5 分钟内走完 9 步：一条命令启动并打开浏览器，Agent 用真实工具分析仓库，界面按时间线实时展示，运行中可以插入指令，重启服务后会话续上。

**Architecture:** SDK 侧补三块缺口：`SessionOptions.permissions` 让 Session 承载的 Agent 能放行工具；`JsonlAgentServerStore` 用内存 store 的日志钩子把 AgentServer 状态落到 JSONL 文件；macOS seatbelt profile 补一条根目录读取规则。示例侧重写 `examples/web-agent-server`（server.mjs、DemoProvider.mjs、smoke.mjs、client.js、index.html），脚手架把这些模板拷进生成的项目并在交互终端自动启动。

**Tech Stack:** TypeScript (ESM, Node >= 22.14), vitest, biome, esbuild（浏览器端打包），`@blade-ai/agent-sdk` 自身的 `AgentServer` / `AgentClient` / `JsonlSessionRepository` / `getSandboxExecutor`，`write-file-atomic`，`open`。

**Spec:** `docs/superpowers/specs/2026-09-18-web-preset-first-run-design.md`（执行每个任务前先读对应章节；本计划的取舍都来自它）。

## Global Constraints

- Node.js `>=22.14.0`，ESM only；TypeScript 源码里相对导入必须带 `.js` 后缀。
- 代码风格由 biome 决定：单引号、分号、尾逗号、2 空格缩进、行宽 100。每次提交前运行 `pnpm lint:fix` 再 `pnpm lint`，并保证 `pnpm type-check` 通过。
- 架构测试（`src/__tests__/simplificationArchitecture.test.ts`）：生产文件不超过 900 行，任何函数不超过 150 行。`examples/` 不受此限，但保持同样风格。
- 测试用 vitest（`pnpm test` 即 `vitest run`），测试文件放在源码旁的 `__tests__/` 目录。
- 每个用户可见的改动都要在 `.changes/` 下加一个 JSON fragment：`{"type": "feature"|"fix", "en": "...", "zh-CN": "..."}`，文件名 kebab-case。`pnpm changelog:check` 会校验。
- SDK 不新增运行时依赖。脚手架 web preset 可以声明 `open`（SDK 自身已依赖，版本从 SDK manifest 读取）。
- 不改协议（`src/protocol`）。production preset 的 `examples/production-stack` 服务端不改；它共用 `client.js`，改 UI 后必须保证它的 smoke 仍能通过。
- 分支 `feat/web-preset-first-run`，每个任务结束提交一次，conventional commit 格式。
- 已核实的运行时事实（写代码时直接依赖，不要再猜）：
  - 权限签名形如 `Read:<file_path>`、`Bash:<command>`；规则匹配是精确匹配或以 `*` 结尾的前缀匹配。规则处理器对空规则一律返回 `ask`，并且模式处理器的 `allow` 不会清掉规则留下的确认原因，所以放行必须靠 `permissions.allow`。
  - `permissionMode: 'default'` 下非只读工具一定会再被模式处理器要求确认；只有 `'yolo'` 会放行 Bash（破坏性命令仍要确认）。
  - `sandbox.autoAllowBashIfSandboxed` 在 SDK 里没有消费者，不要依赖它。
  - 沙箱内网络默认放行，文件写入限定在工作目录和 `/tmp`，`$HOME` 只读。
  - `AgentServer.close()` 只关闭进程内的 Session 对象，不会把 store 里的会话记录标成 `closed`，所以重启后 `resumeSession` 可以继续同一会话。
  - Bash 工具结果在对话消息里是 JSON 文本：`{"stdout": string, "stderr": string, "exit_code": number}`。Glob 结果是文本，匹配到的文件以 `- ` 开头逐行列出。Read 结果是文件原文。

## 文件结构

SDK（`src/`）：

| 文件 | 职责 |
|---|---|
| `session/types.ts` | `SessionOptions.permissions` 字段 |
| `session/SessionState.ts` | 把 `permissions` 合并进 `BladeConfig` |
| `session/__tests__/SessionPermissionRules.test.ts` | 新增：规则放行与默认询问 |
| `sandbox/SandboxExecutor.ts` | seatbelt profile 增加根目录读取 |
| `sandbox/__tests__/SandboxExecutor.test.ts` | 断言 profile 含新规则 |
| `server/RuntimeStore.ts` | 两个新错误码 |
| `server/AgentServerStore.ts` | 日志条目类型、journal 选项、`restore`、`snapshot`、failed 状态 |
| `server/JsonlAgentServerStore.ts` | 新增：JSONL 文件 store |
| `server/runtime.ts` | 导出新类型与新类 |
| `browser/server-only-stub.ts` | 浏览器构建下的 stub |
| `server/__tests__/AgentServerStoreJournal.test.ts` | 新增：日志钩子与快照回放 |
| `server/__tests__/helpers/agentServerStoreContract.ts` | 新增：两种 store 共用的契约测试 |
| `server/__tests__/JsonlAgentServerStore.test.ts` | 新增：文件 store |
| `cli/createBladeAgent.ts`、`cli/create-blade-agent.ts`、`cli/__tests__/createBladeAgent.test.ts` | 脚手架 |

示例（`examples/web-agent-server/`）：

| 文件 | 职责 |
|---|---|
| `server.mjs` | 参数、`.env` 与 key、模型解析、沙箱探测、持久化、`AgentServer`、HTTP、打开浏览器、smoke 入口 |
| `DemoProvider.mjs` | 新增：无 key 时的脚本化 provider 与报告生成 |
| `smoke.mjs` | 新增：9 步自动验收 |
| `client.js`、`index.html` | 时间线界面、steering、审批卡片、恢复 |

其他：`scripts/verify-create-blade-agent.mjs`、`docs/server-runtime.md`、`docs/en/server-runtime.md`、`docs/golden-paths.md`、`docs/en/golden-paths.md`、`examples/README.md`、`README.md`、`README.zh-CN.md`、`.changes/*.json`。

---

### Task 1: `SessionOptions.permissions` 透传

**Files:**
- Modify: `src/session/types.ts:48`（导入）与 `:227-228`（字段）
- Modify: `src/session/SessionState.ts:194-208`（`buildBladeConfig`）
- Create: `src/session/__tests__/SessionPermissionRules.test.ts`
- Create: `.changes/session-permission-rules.json`

**Interfaces:**
- Produces: `SessionOptions.permissions?: PermissionsConfig`（`{ allow?: string[]; ask?: string[]; deny?: string[] }`，来自 `src/types/permissions.ts`）。Task 6 的 `server.mjs` 依赖它。

- [ ] **Step 1: 写失败测试**

创建 `src/session/__tests__/SessionPermissionRules.test.ts`：

```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ModelServiceConfig } from '../../model/config.js';
import type { ModelMessage } from '../../model/message.js';
import type { ModelResponse, ModelService } from '../../model/service.js';
import { createSession } from '../../node/index.js';
import { ProviderRegistry } from '../../services/ProviderRegistry.js';

function readOnceService(config: ModelServiceConfig, filePath: string): ModelService {
  const next = (messages: readonly ModelMessage[]): ModelResponse =>
    messages.some((message) => message.role === 'tool')
      ? { content: 'done' }
      : {
          content: '',
          toolCalls: [
            {
              id: 'call-read',
              type: 'function',
              function: { name: 'Read', arguments: JSON.stringify({ file_path: filePath }) },
            },
          ],
        };
  return {
    async chat(messages) {
      return next(messages);
    },
    async sideQuery() {
      return { content: '' };
    },
    async *streamChat(messages) {
      const response = next(messages);
      yield response;
      yield { finishReason: response.toolCalls ? 'tool_calls' : 'stop' };
    },
    getConfig() {
      return config;
    },
    updateConfig() {},
  };
}

async function runReadTurn(permissions?: { allow: string[] }) {
  const directory = await mkdtemp(join(tmpdir(), 'session-permission-rules-'));
  const filePath = join(directory, 'notes.txt');
  await writeFile(filePath, 'hello from the rules test\n');
  const confirmations: string[] = [];
  const session = await createSession({
    provider: { type: 'read-once' },
    providerRegistry: new ProviderRegistry([
      { type: 'read-once', create: (config) => readOnceService({ ...config }, filePath) },
    ]),
    model: 'read-once',
    allowedTools: ['Read'],
    defaultContext: { capabilities: { filesystem: { roots: [directory], cwd: directory } } },
    ...(permissions ? { permissions } : {}),
    confirmationHandler: {
      async requestConfirmation(details) {
        confirmations.push(details.toolName ?? 'unknown');
        return { approved: true, scope: 'once' };
      },
    },
    maxTurns: 4,
  });
  const toolResults: string[] = [];
  await session.send('read the notes');
  for await (const event of session.stream()) {
    if (event.type === 'tool_result') toolResults.push(event.isError ? 'error' : 'ok');
    if (event.type === 'result' || event.type === 'error') break;
  }
  await session.close();
  return { confirmations, toolResults };
}

describe('SessionOptions.permissions', () => {
  it('lets matching allow rules skip the confirmation prompt', async () => {
    const { confirmations, toolResults } = await runReadTurn({ allow: ['Read', 'Read:*'] });
    expect(toolResults).toEqual(['ok']);
    expect(confirmations).toEqual([]);
  });

  it('keeps asking when no rule matches', async () => {
    const { confirmations, toolResults } = await runReadTurn();
    expect(toolResults).toEqual(['ok']);
    expect(confirmations).toEqual(['Read']);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/session/__tests__/SessionPermissionRules.test.ts`
Expected: 第一个用例失败（`confirmations` 为 `['Read']` 而不是 `[]`），第二个通过。如果第一个用例报的是类型错误（`permissions` 不在 `SessionOptions` 上），同样算失败。

- [ ] **Step 3: 加字段与合并逻辑**

`src/session/types.ts` 第 48 行改为：

```ts
import type {
  PermissionHandler,
  PermissionsConfig,
  PermissionUpdate,
} from '../types/permissions.js';
```

在 `permissionHandler?: PermissionHandler;`（第 228 行）之后插入：

```ts
  /**
   * Static permission rules matched against each tool invocation's permission
   * signature (`<Tool>` or `<Tool>:<detail>`, for example `Bash:npm ls`). A rule is
   * either an exact signature or a prefix ending in `*`. Invocations that match an
   * `allow` rule skip the confirmation prompt; everything else keeps the default
   * behaviour of asking.
   */
  permissions?: PermissionsConfig;
```

`src/session/SessionState.ts` 的 `buildBladeConfig()` 里把

```ts
      permissions: {
        allow: [],
        deny: [],
      },
```

改为

```ts
      permissions: {
        allow: [],
        deny: [],
        ...this.options.permissions,
      },
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/session/__tests__/SessionPermissionRules.test.ts`
Expected: 2 passed。

- [ ] **Step 5: changelog fragment、lint、提交**

创建 `.changes/session-permission-rules.json`：

```json
{
  "type": "feature",
  "en": "Add `permissions` allow/ask/deny rules to SessionOptions so Session-hosted Agents can skip confirmation for trusted tools.",
  "zh-CN": "SessionOptions 新增 `permissions` 放行/询问/拒绝规则，Session 承载的 Agent 可以为可信工具跳过确认。"
}
```

```bash
pnpm lint:fix && pnpm lint && pnpm type-check
git add src/session/types.ts src/session/SessionState.ts src/session/__tests__/SessionPermissionRules.test.ts .changes/session-permission-rules.json
git commit -m "feat(session): accept permission rules in SessionOptions"
```

---

### Task 2: macOS seatbelt profile 允许读取根目录

**Files:**
- Modify: `src/sandbox/SandboxExecutor.ts:291`（`generateSeatbeltProfile`）
- Modify: `src/sandbox/__tests__/SandboxExecutor.test.ts`（`describe('wrapCommand')` 内新增用例）
- Create: `.changes/macos-seatbelt-root-read.json`

**Interfaces:**
- Produces: 无新 API。效果是 macOS 上 `getSandboxExecutor().wrapCommand()` 包出来的命令能真正执行；Task 6 的沙箱探测依赖它。

- [ ] **Step 1: 写失败测试**

在 `src/sandbox/__tests__/SandboxExecutor.test.ts` 顶部导入后追加：

```ts
import { readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
```

在 `describe('wrapCommand', () => {` 块内新增：

```ts
    it('lets sandboxed processes read the filesystem root on macOS', () => {
      const executor = getSandboxExecutor();
      vi.spyOn(executor, 'getCapabilities').mockReturnValue({
        available: true,
        type: 'seatbelt',
        version: 'macOS built-in',
        features: {
          fileSystemIsolation: true,
          networkIsolation: true,
          processIsolation: true,
        },
      });

      const wrapped = executor.wrapCommand('echo ok', { workDir: '/home/test' }, { enabled: true });
      const profilePath = /-f '([^']+)'/.exec(wrapped)?.[1];
      expect(profilePath).toBeDefined();
      const profile = readFileSync(profilePath as string, 'utf8');
      rmSync(dirname(profilePath as string), { recursive: true, force: true });

      expect(profile).toContain('(allow file-read* (literal "/"))');
    });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/sandbox/__tests__/SandboxExecutor.test.ts -t "filesystem root"`
Expected: FAIL，`expect(profile).toContain(...)` 不满足。

- [ ] **Step 3: 加规则**

`src/sandbox/SandboxExecutor.ts` 的 `generateSeatbeltProfile` 中，`lines.push('(allow file-read-metadata)');` 之后插入：

```ts
    // Newer macOS releases abort the sandboxed process unless "/" itself is readable.
    lines.push('(allow file-read* (literal "/"))');
```

- [ ] **Step 4: 运行测试确认通过，并在 macOS 上做一次真实验证**

Run: `pnpm vitest run src/sandbox/__tests__/SandboxExecutor.test.ts`
Expected: 全部通过。

在 macOS 上额外运行（构建后用真实 sandbox-exec 跑一条命令）：

```bash
pnpm build && node --input-type=module -e "
import { spawnSync } from 'node:child_process';
import { getSandboxExecutor } from '@blade-ai/agent-sdk/advanced';
const e = getSandboxExecutor();
const w = e.wrapCommand('echo sandbox-ok', e.buildExecutionOptions(process.cwd()), { enabled: true });
const r = spawnSync('bash', ['-c', w], { encoding: 'utf8' });
console.log(r.status, r.stdout.trim(), r.stderr.trim());
"
```

Expected: 输出 `0 sandbox-ok`。修复前这里是 `134`（Abort trap）。

- [ ] **Step 5: fragment 与提交**

创建 `.changes/macos-seatbelt-root-read.json`：

```json
{
  "type": "fix",
  "en": "Allow sandboxed shell commands to read the filesystem root so the macOS seatbelt sandbox no longer aborts on current macOS releases.",
  "zh-CN": "沙箱内的 shell 命令现在允许读取文件系统根目录，macOS seatbelt 沙箱在新版 macOS 上不再直接崩溃。"
}
```

```bash
pnpm lint:fix && pnpm lint
git add src/sandbox/SandboxExecutor.ts src/sandbox/__tests__/SandboxExecutor.test.ts .changes/macos-seatbelt-root-read.json
git commit -m "fix(sandbox): allow reading the filesystem root in the seatbelt profile"
```

---

### Task 3: `InMemoryAgentServerStore` 日志钩子、`restore`、`snapshot`

**Files:**
- Modify: `src/server/RuntimeStore.ts:20-22`（错误码）
- Modify: `src/server/AgentServerStore.ts`（第 139 行 `interface CommandLease` 到文件末尾整体替换；第 9-15 行导入改为值导入）
- Create: `src/server/__tests__/AgentServerStoreJournal.test.ts`

**Interfaces:**
- Consumes: `RuntimeStoreError` 来自 `./RuntimeStore.js`（`RuntimeStore.ts` 只以 `import type` 引用 `AgentServerStore`，没有运行时循环）。
- Produces（Task 4 依赖）：
  - `interface CommandLeaseSnapshot { leaseId; commandFingerprint; expiresAt: number | null; sealed; result?; abandonReason? }`
  - `type AgentServerStoreJournalEntry = { kind: 'session'; record } | { kind: 'event'; tenantId; sessionId; event; idempotencyKey? } | { kind: 'event_key'; tenantId; sessionId; idempotencyKey; event } | { kind: 'lease'; tenantId; commandId; lease: CommandLeaseSnapshot | null }`
  - `interface AgentServerStoreJournal { append(entry: AgentServerStoreJournalEntry): Promise<void> }`
  - `InMemoryAgentServerStoreOptions.journal?: AgentServerStoreJournal`
  - `InMemoryAgentServerStore#restore(entries: Iterable<AgentServerStoreJournalEntry>): void`
  - `InMemoryAgentServerStore#snapshot(): AgentServerStoreJournalEntry[]`
  - `RuntimeStoreErrorCode` 新增 `'RUNTIME_STORE_JOURNAL_FAILED' | 'RUNTIME_STORE_CORRUPT_JOURNAL'`

- [ ] **Step 1: 写失败测试**

创建 `src/server/__tests__/AgentServerStoreJournal.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { AGENT_PROTOCOL_VERSION } from '../../protocol/index.js';
import { CommandId, SessionId } from '../../types/identifiers.js';
import {
  type AgentServerStoreJournalEntry,
  InMemoryAgentServerStore,
} from '../AgentServerStore.js';
import { RuntimeStoreError } from '../RuntimeStore.js';

const tenantId = 'tenant-journal';
const sessionId = SessionId('session-journal');

function record(id: string) {
  return {
    tenantId,
    createdBy: 'user-a',
    sessionId: SessionId(id),
    status: 'active' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function event(delta: string) {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    sessionId,
    occurredAt: '2026-01-01T00:00:00.000Z',
    type: 'session.stream' as const,
    data: { type: 'content' as const, delta, sessionId },
  };
}

function recordingJournal() {
  const entries: AgentServerStoreJournalEntry[] = [];
  return {
    entries,
    journal: {
      async append(entry: AgentServerStoreJournalEntry) {
        entries.push(structuredClone(entry));
      },
    },
  };
}

describe('InMemoryAgentServerStore journal', () => {
  it('records every state change in order and skips idempotent repeats', async () => {
    const { entries, journal } = recordingJournal();
    let now = 1000;
    const store = new InMemoryAgentServerStore({ journal, now: () => now });
    await store.putSession(record('session-journal'));
    const claim = await store.claimCommand(tenantId, CommandId('command-1'), 'fp', 100);
    if (claim.status !== 'claimed') throw new Error('expected a claim');
    await store.sealCommand(tenantId, CommandId('command-1'), claim.leaseId);
    await store.completeCommand(tenantId, CommandId('command-1'), claim.leaseId, {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      commandId: CommandId('command-1'),
      ok: true,
      data: {},
    });
    const released = await store.claimCommand(tenantId, CommandId('command-2'), 'fp', 100);
    if (released.status !== 'claimed') throw new Error('expected a claim');
    await store.releaseCommand(tenantId, CommandId('command-2'), released.leaseId);
    const first = await store.appendEvent(tenantId, sessionId, event('one'), {
      idempotencyKey: 'k-1',
    });
    await store.appendEvent(tenantId, sessionId, event('one'), { idempotencyKey: 'k-1' });
    now += 1;

    expect(entries.map((entry) => entry.kind)).toEqual([
      'session',
      'lease',
      'lease',
      'lease',
      'lease',
      'lease',
      'event',
    ]);
    expect(entries[1]).toMatchObject({
      kind: 'lease',
      commandId: 'command-1',
      lease: { leaseId: claim.leaseId, sealed: false, expiresAt: 1100 },
    });
    expect(entries[2]).toMatchObject({ lease: { sealed: true, expiresAt: null } });
    expect(entries[3]).toMatchObject({ lease: { sealed: true, result: { ok: true } } });
    expect(entries[5]).toMatchObject({ kind: 'lease', commandId: 'command-2', lease: null });
    expect(entries[6]).toMatchObject({
      kind: 'event',
      idempotencyKey: 'k-1',
      event: { eventId: first.eventId, sequence: 1 },
    });
  });

  it('restores an equivalent store from its own snapshot', async () => {
    let now = 1000;
    const source = new InMemoryAgentServerStore({ maxEventsPerSession: 2, now: () => now });
    await source.putSession(record('session-journal'));
    const claim = await source.claimCommand(tenantId, CommandId('sealed'), 'fp', 100);
    if (claim.status !== 'claimed') throw new Error('expected a claim');
    await source.sealCommand(tenantId, CommandId('sealed'), claim.leaseId);
    const keyed = await source.appendEvent(tenantId, sessionId, event('one'), {
      idempotencyKey: 'terminal',
    });
    await source.appendEvent(tenantId, sessionId, event('two'));
    await source.appendEvent(tenantId, sessionId, event('three'));

    const snapshot = source.snapshot();
    expect(snapshot.map((entry) => entry.kind).sort()).toEqual(
      ['event', 'event', 'event_key', 'lease', 'session'].sort(),
    );

    const restored = new InMemoryAgentServerStore({ maxEventsPerSession: 2, now: () => now });
    restored.restore(snapshot);
    now += 10_000;

    await expect(restored.getSession(tenantId, sessionId)).resolves.toMatchObject({ sessionId });
    await expect(restored.getEventStreamRange(tenantId, sessionId)).resolves.toEqual({
      firstSequence: 2,
      headSequence: 3,
    });
    await expect(restored.readEvents(tenantId, sessionId, { after: 1 })).resolves.toMatchObject({
      events: [{ sequence: 2 }, { sequence: 3 }],
    });
    await expect(restored.readEvents(tenantId, sessionId, { after: 0 })).rejects.toThrow(/stale/i);
    const repeat = await restored.appendEvent(tenantId, sessionId, event('one'), {
      idempotencyKey: 'terminal',
    });
    expect(repeat.eventId).toBe(keyed.eventId);
    await expect(restored.claimCommand(tenantId, CommandId('sealed'), 'fp', 100)).resolves.toEqual({
      status: 'in_progress',
      retryAfterMs: 1000,
    });
    const next = await restored.appendEvent(tenantId, sessionId, event('four'));
    expect(next.sequence).toBe(4);
  });

  it('refuses to restore into a store that already has state', async () => {
    const store = new InMemoryAgentServerStore();
    await store.putSession(record('session-journal'));
    expect(() => store.restore([])).toThrow(/empty store/i);
  });

  it('fails closed after the journal rejects a write', async () => {
    const failure = new Error('disk full');
    const store = new InMemoryAgentServerStore({
      journal: {
        async append() {
          throw failure;
        },
      },
    });
    await expect(store.putSession(record('session-journal'))).rejects.toBe(failure);
    await expect(store.healthCheck()).resolves.toMatchObject({ ready: false });
    await expect(store.appendEvent(tenantId, sessionId, event('one'))).rejects.toMatchObject({
      code: 'RUNTIME_STORE_JOURNAL_FAILED',
    });
    await expect(store.appendEvent(tenantId, sessionId, event('one'))).rejects.toBeInstanceOf(
      RuntimeStoreError,
    );
    await expect(store.getSession(tenantId, sessionId)).resolves.toMatchObject({ sessionId });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/server/__tests__/AgentServerStoreJournal.test.ts`
Expected: 类型错误或 4 个用例全部失败（`journal` 选项、`restore`、`snapshot` 都不存在）。

- [ ] **Step 3: 错误码**

`src/server/RuntimeStore.ts` 的 `RuntimeStoreErrorCode` 改为：

```ts
export type RuntimeStoreErrorCode =
  | 'RUNTIME_STORE_QUOTA_EXCEEDED'
  | 'RUNTIME_STORE_INVALID_TRANSACTION'
  | 'RUNTIME_STORE_JOURNAL_FAILED'
  | 'RUNTIME_STORE_CORRUPT_JOURNAL';
```

- [ ] **Step 4: 改写 `AgentServerStore.ts`**

第 9-15 行的导入改成值导入（`CommandId` 与 `SessionId` 在 `snapshot()` 里要当构造函数用）：

```ts
import {
  CommandId,
  EventId,
  EventSequence,
  ExecutionLeaseId,
  SessionId,
} from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import { RuntimeStoreError } from './RuntimeStore.js';
```

从第 139 行 `interface CommandLease {` 起到文件末尾，整体替换为：

```ts
export interface CommandLeaseSnapshot {
  readonly leaseId: ExecutionLeaseId;
  readonly commandFingerprint: string;
  /** Milliseconds since the epoch, or null for a lease that never expires. */
  readonly expiresAt: number | null;
  readonly sealed: boolean;
  readonly result?: AgentCommandResult;
  readonly abandonReason?: string;
}

/**
 * One durable state change. A journal receives these in commit order and a
 * restore replays them in the same order; `event_key` only appears in snapshots,
 * for idempotency records whose event has already left the retained log.
 */
export type AgentServerStoreJournalEntry =
  | { readonly kind: 'session'; readonly record: AgentServerSessionRecord }
  | {
      readonly kind: 'event';
      readonly tenantId: string;
      readonly sessionId: SessionId;
      readonly event: AgentServerEvent;
      readonly idempotencyKey?: string;
    }
  | {
      readonly kind: 'event_key';
      readonly tenantId: string;
      readonly sessionId: SessionId;
      readonly idempotencyKey: string;
      readonly event: AgentServerEvent;
    }
  | {
      readonly kind: 'lease';
      readonly tenantId: string;
      readonly commandId: CommandId;
      readonly lease: CommandLeaseSnapshot | null;
    };

export interface AgentServerStoreJournal {
  append(entry: AgentServerStoreJournalEntry): Promise<void>;
}

interface CommandLease {
  leaseId: ExecutionLeaseId;
  commandFingerprint: string;
  expiresAt: number;
  sealed: boolean;
  result?: AgentCommandResult;
  abandonReason?: string;
}

interface EventLog {
  firstSequence: number;
  nextSequence: number;
  events: AgentServerEvent[];
  waiters: Set<() => void>;
}

function scopedKey(tenantId: string, id: string): string {
  return JSON.stringify([tenantId, id]);
}

function parseScopedKey(key: string): { tenantId: string; id: string } {
  const [tenantId, id] = JSON.parse(key) as [string, string];
  return { tenantId, id };
}

function toLeaseSnapshot(lease: CommandLease): CommandLeaseSnapshot {
  return {
    leaseId: lease.leaseId,
    commandFingerprint: lease.commandFingerprint,
    expiresAt: Number.isFinite(lease.expiresAt) ? lease.expiresAt : null,
    sealed: lease.sealed,
    ...(lease.result ? { result: structuredClone(lease.result) } : {}),
    ...(lease.abandonReason ? { abandonReason: lease.abandonReason } : {}),
  };
}

function fromLeaseSnapshot(snapshot: CommandLeaseSnapshot): CommandLease {
  return {
    leaseId: snapshot.leaseId,
    commandFingerprint: snapshot.commandFingerprint,
    expiresAt: snapshot.expiresAt ?? Number.POSITIVE_INFINITY,
    sealed: snapshot.sealed,
    ...(snapshot.result ? { result: structuredClone(snapshot.result) } : {}),
    ...(snapshot.abandonReason ? { abandonReason: snapshot.abandonReason } : {}),
  };
}

export interface InMemoryAgentServerStoreOptions {
  maxEventsPerSession?: number;
  now?: () => number;
  /**
   * Receives every committed change after it is applied in memory and before the
   * mutating call resolves. A rejected append marks the store failed: further
   * mutations reject with `RUNTIME_STORE_JOURNAL_FAILED` and `healthCheck()`
   * reports not ready, so memory can never run ahead of the journal by more than
   * the one write that was reported as failed.
   */
  journal?: AgentServerStoreJournal;
}

/**
 * Process-local reference implementation. Production deployments with more
 * than one server instance should provide a shared implementation.
 */
export class InMemoryAgentServerStore implements AgentServerStore {
  private readonly commandLeases = new Map<string, CommandLease>();
  private readonly sessions = new Map<string, AgentServerSessionRecord>();
  private readonly eventLogs = new Map<string, EventLog>();
  private readonly maxEventsPerSession: number;
  /**
   * Idempotency records, kept outside the (trimmable) event logs so a retry that
   * outlives retention is still recognised.
   */
  private readonly eventKeys = new Map<string, Map<string, AgentServerEvent>>();
  private readonly now: () => number;
  private readonly journal: AgentServerStoreJournal | undefined;
  private journalFailure: unknown;

  constructor(options: InMemoryAgentServerStoreOptions = {}) {
    this.maxEventsPerSession = options.maxEventsPerSession ?? 1000;
    this.now = options.now ?? Date.now;
    this.journal = options.journal;
    if (!Number.isSafeInteger(this.maxEventsPerSession) || this.maxEventsPerSession < 1) {
      throw new RangeError('maxEventsPerSession must be a positive safe integer');
    }
  }

  async healthCheck(): Promise<{ ready: boolean; details?: JsonObject }> {
    return this.journalFailure === undefined
      ? { ready: true }
      : { ready: false, details: { reason: 'journal write failed' } };
  }

  /**
   * Load previously journaled entries. Only valid on a store without state, so a
   * restart can never mix a replay with live writes.
   */
  restore(entries: Iterable<AgentServerStoreJournalEntry>): void {
    if (
      this.sessions.size > 0 ||
      this.eventLogs.size > 0 ||
      this.commandLeases.size > 0 ||
      this.eventKeys.size > 0
    ) {
      throw new Error('restore() requires an empty store');
    }
    for (const entry of entries) {
      switch (entry.kind) {
        case 'session':
          this.sessions.set(
            scopedKey(entry.record.tenantId, entry.record.sessionId),
            structuredClone(entry.record),
          );
          break;
        case 'event':
          this.restoreEvent(entry.tenantId, entry.sessionId, entry.event, entry.idempotencyKey);
          break;
        case 'event_key':
          this.rememberEventKey(
            scopedKey(entry.tenantId, entry.sessionId),
            entry.idempotencyKey,
            entry.event,
          );
          break;
        case 'lease': {
          const key = scopedKey(entry.tenantId, entry.commandId);
          if (entry.lease) {
            this.commandLeases.set(key, fromLeaseSnapshot(entry.lease));
          } else {
            this.commandLeases.delete(key);
          }
          break;
        }
      }
    }
  }

  /** Every entry needed to rebuild the current state with `restore()`. */
  snapshot(): AgentServerStoreJournalEntry[] {
    const entries: AgentServerStoreJournalEntry[] = [];
    for (const record of this.sessions.values()) {
      entries.push({ kind: 'session', record: structuredClone(record) });
    }
    const scopes = new Set([...this.eventLogs.keys(), ...this.eventKeys.keys()]);
    for (const key of scopes) {
      const { tenantId, id } = parseScopedKey(key);
      const sessionId = SessionId(id);
      const keys = this.eventKeys.get(key) ?? new Map<string, AgentServerEvent>();
      const keyByEventId = new Map(
        [...keys].map(([idempotencyKey, event]) => [event.eventId, idempotencyKey] as const),
      );
      const retained = new Set<string>();
      for (const event of this.eventLogs.get(key)?.events ?? []) {
        retained.add(event.eventId);
        const idempotencyKey = keyByEventId.get(event.eventId);
        entries.push({
          kind: 'event',
          tenantId,
          sessionId,
          event: structuredClone(event),
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        });
      }
      for (const [idempotencyKey, event] of keys) {
        if (!retained.has(event.eventId)) {
          entries.push({
            kind: 'event_key',
            tenantId,
            sessionId,
            idempotencyKey,
            event: structuredClone(event),
          });
        }
      }
    }
    for (const [key, lease] of this.commandLeases) {
      const { tenantId, id } = parseScopedKey(key);
      entries.push({ kind: 'lease', tenantId, commandId: CommandId(id), lease: toLeaseSnapshot(lease) });
    }
    return entries;
  }

  async claimCommand(
    tenantId: string,
    commandId: CommandId,
    commandFingerprint: string,
    ttlMs: number,
  ): Promise<AgentCommandClaim> {
    this.assertWritable();
    const key = scopedKey(tenantId, commandId);
    const existing = this.commandLeases.get(key);
    const now = this.now();
    if (existing && existing.commandFingerprint !== commandFingerprint) {
      return { status: 'conflict' };
    }
    if (existing?.result) {
      return { status: 'completed', result: structuredClone(existing.result) };
    }
    if (existing?.abandonReason) {
      return { status: 'abandoned', reason: existing.abandonReason };
    }
    if (existing && existing.expiresAt > now) {
      return {
        status: 'in_progress',
        retryAfterMs: Number.isFinite(existing.expiresAt)
          ? Math.max(1, existing.expiresAt - now)
          : 1000,
      };
    }

    const leaseId = ExecutionLeaseId(nanoid());
    this.commandLeases.set(key, {
      leaseId,
      commandFingerprint,
      expiresAt: now + ttlMs,
      sealed: false,
    });
    await this.recordLease(tenantId, commandId);
    return { status: 'claimed', leaseId };
  }

  async completeCommand(
    tenantId: string,
    commandId: CommandId,
    leaseId: ExecutionLeaseId,
    result: AgentCommandResult,
  ): Promise<void> {
    this.assertWritable();
    const key = scopedKey(tenantId, commandId);
    const current = this.commandLeases.get(key);
    if (!current || current.leaseId !== leaseId) {
      throw new Error(`Command lease ${commandId}/${leaseId} is no longer active`);
    }
    this.commandLeases.set(key, {
      ...current,
      expiresAt: Number.POSITIVE_INFINITY,
      sealed: true,
      result: structuredClone(result),
    });
    await this.recordLease(tenantId, commandId);
  }

  async sealCommand(
    tenantId: string,
    commandId: CommandId,
    leaseId: ExecutionLeaseId,
  ): Promise<void> {
    this.assertWritable();
    const key = scopedKey(tenantId, commandId);
    const current = this.commandLeases.get(key);
    if (!current || current.leaseId !== leaseId || current.result) {
      throw new Error(`Command lease ${commandId}/${leaseId} is no longer active`);
    }
    current.expiresAt = Number.POSITIVE_INFINITY;
    current.sealed = true;
    await this.recordLease(tenantId, commandId);
  }

  async releaseCommand(
    tenantId: string,
    commandId: CommandId,
    leaseId: ExecutionLeaseId,
  ): Promise<void> {
    this.assertWritable();
    const key = scopedKey(tenantId, commandId);
    const current = this.commandLeases.get(key);
    if (current?.leaseId === leaseId && !current.sealed && !current.result) {
      this.commandLeases.delete(key);
      await this.recordLease(tenantId, commandId);
    }
  }

  async abandonCommand(tenantId: string, commandId: CommandId, reason: string): Promise<boolean> {
    if (!reason.trim()) {
      throw new RangeError('An abandoned command requires a reason');
    }
    this.assertWritable();
    const key = scopedKey(tenantId, commandId);
    const current = this.commandLeases.get(key);
    // Already abandoned: report "nothing changed" so repeated sweeps are no-ops and
    // the first reason stays the recorded one.
    if (!current?.sealed || current.result || current.abandonReason) {
      return false;
    }
    this.commandLeases.set(key, { ...current, abandonReason: reason });
    await this.recordLease(tenantId, commandId);
    return true;
  }

  async putSession(record: AgentServerSessionRecord): Promise<void> {
    this.assertWritable();
    this.sessions.set(scopedKey(record.tenantId, record.sessionId), structuredClone(record));
    await this.record({ kind: 'session', record: structuredClone(record) });
  }

  async getSession(
    tenantId: string,
    sessionId: SessionId,
  ): Promise<AgentServerSessionRecord | null> {
    const record = this.sessions.get(scopedKey(tenantId, sessionId));
    return record ? structuredClone(record) : null;
  }

  async listSessions(
    tenantId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<{ sessions: AgentServerSessionRecord[]; nextCursor?: string }> {
    const limit = options.limit ?? 50;
    const offset = options.cursor ? Number.parseInt(options.cursor, 10) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError('Session list cursor is invalid');
    }
    const sessions = Array.from(this.sessions.values())
      .filter((record) => record.tenantId === tenantId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const page = sessions.slice(offset, offset + limit).map((record) => structuredClone(record));
    const nextOffset = offset + page.length;
    return {
      sessions: page,
      ...(nextOffset < sessions.length ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  async appendEvent(
    tenantId: string,
    sessionId: SessionId,
    event: Omit<AgentServerEvent, 'eventId' | 'sequence'>,
    options: { readonly idempotencyKey?: string } = {},
  ): Promise<AgentServerEvent> {
    if (event.sessionId !== sessionId) {
      throw new RangeError('Event Session does not match the target event log');
    }
    this.assertWritable();
    const key = scopedKey(tenantId, sessionId);
    const log = this.getOrCreateEventLog(key);
    if (options.idempotencyKey !== undefined) {
      // Checked synchronously and without awaiting anything: an `await` here would
      // yield between the check and the write, letting a concurrent append with the
      // same key pass its own check and store a second event.
      const existing = this.readIdempotencyRecord(key, options.idempotencyKey);
      if (existing) {
        return existing;
      }
    }
    const stored = {
      ...event,
      protocolVersion: AGENT_PROTOCOL_VERSION,
      eventId: EventId(nanoid()),
      sequence: EventSequence(log.nextSequence++),
    } as AgentServerEvent;
    if (options.idempotencyKey !== undefined) {
      // Deep copy at the write boundary: the log stores a clone, and the key record
      // must be isolated from the caller's object in the same way, or a later
      // mutation of `event.data` would change one and not the other.
      this.rememberEventKey(key, options.idempotencyKey, stored);
    }
    this.appendToLog(log, stored);
    try {
      await this.record({
        kind: 'event',
        tenantId,
        sessionId,
        event: structuredClone(stored),
        ...(options.idempotencyKey !== undefined ? { idempotencyKey: options.idempotencyKey } : {}),
      });
    } finally {
      for (const wake of log.waiters) {
        wake();
      }
      log.waiters.clear();
    }
    return structuredClone(stored);
  }

  /** Test hook: drop retained events without touching the idempotency records. */
  async trimAgentEventsForTesting(tenantId: string, sessionId: SessionId): Promise<void> {
    this.eventLogs.delete(scopedKey(tenantId, sessionId));
  }

  async getEventStreamRange(
    tenantId: string,
    sessionId: SessionId,
  ): Promise<{ firstSequence: number; headSequence: number } | null> {
    const log = this.eventLogs.get(scopedKey(tenantId, sessionId));
    if (!log || log.nextSequence <= log.firstSequence) {
      return null;
    }
    return { firstSequence: log.firstSequence, headSequence: log.nextSequence - 1 };
  }

  async getEventByIdempotencyKey(
    tenantId: string,
    sessionId: SessionId,
    idempotencyKey: string,
  ): Promise<AgentServerEvent | null> {
    return this.readIdempotencyRecord(scopedKey(tenantId, sessionId), idempotencyKey);
  }

  private readIdempotencyRecord(key: string, idempotencyKey: string): AgentServerEvent | null {
    const existing = this.eventKeys.get(key)?.get(idempotencyKey);
    return existing ? structuredClone(existing) : null;
  }

  async readEvents(
    tenantId: string,
    sessionId: SessionId,
    options: { after?: number; limit?: number } = {},
  ): Promise<AgentEventPage> {
    const after = options.after ?? 0;
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new RangeError('Event cursor is invalid');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError('Event page limit must be between 1 and 1000');
    }
    const log = this.eventLogs.get(scopedKey(tenantId, sessionId));
    if (!log) {
      if (after > 0) {
        throw new RangeError('Event cursor is ahead of the session head');
      }
      return {
        events: [],
        nextCursor: null,
        hasMore: false,
      };
    }
    if (after < log.firstSequence - 1) {
      throw new RangeError('Event cursor is stale');
    }
    if (after >= log.nextSequence) {
      throw new RangeError('Event cursor is ahead of the session head');
    }

    const events = log.events
      .filter((event) => event.sequence > after)
      .slice(0, limit)
      .map((event) => structuredClone(event));
    const last = events.at(-1);
    return {
      events,
      nextCursor: last
        ? {
            protocolVersion: AGENT_PROTOCOL_VERSION,
            sessionId,
            sequence: last.sequence,
            eventId: last.eventId,
          }
        : null,
      hasMore: last !== undefined && log.events.some((event) => event.sequence > last.sequence),
    };
  }

  async getLatestEventSequence(tenantId: string, sessionId: SessionId): Promise<number | null> {
    const log = this.eventLogs.get(scopedKey(tenantId, sessionId));
    if (!log || log.events.length === 0) {
      return null;
    }
    return log.nextSequence - 1;
  }

  async waitForEvents(
    tenantId: string,
    sessionId: SessionId,
    after: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const log = this.getOrCreateEventLog(scopedKey(tenantId, sessionId));
    if (log.events.some((event) => event.sequence > after) || signal?.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      const wake = () => {
        signal?.removeEventListener('abort', wake);
        log.waiters.delete(wake);
        resolve();
      };
      log.waiters.add(wake);
      signal?.addEventListener('abort', wake, { once: true });
    });
  }

  private assertWritable(): void {
    if (this.journalFailure !== undefined) {
      throw new RuntimeStoreError(
        'RUNTIME_STORE_JOURNAL_FAILED',
        'The store journal failed earlier; restart the process to replay the journal',
        { cause: this.journalFailure },
      );
    }
  }

  private async record(entry: AgentServerStoreJournalEntry): Promise<void> {
    if (!this.journal) {
      return;
    }
    try {
      await this.journal.append(entry);
    } catch (error) {
      this.journalFailure = error;
      throw error;
    }
  }

  private recordLease(tenantId: string, commandId: CommandId): Promise<void> {
    const lease = this.commandLeases.get(scopedKey(tenantId, commandId));
    return this.record({
      kind: 'lease',
      tenantId,
      commandId,
      lease: lease ? toLeaseSnapshot(lease) : null,
    });
  }

  private rememberEventKey(key: string, idempotencyKey: string, event: AgentServerEvent): void {
    const keys = this.eventKeys.get(key) ?? new Map<string, AgentServerEvent>();
    keys.set(idempotencyKey, structuredClone(event));
    this.eventKeys.set(key, keys);
  }

  private restoreEvent(
    tenantId: string,
    sessionId: SessionId,
    event: AgentServerEvent,
    idempotencyKey?: string,
  ): void {
    const key = scopedKey(tenantId, sessionId);
    const log = this.getOrCreateEventLog(key);
    if (event.sequence < log.nextSequence) {
      throw new RangeError(`Journal event ${event.eventId} is out of order for ${sessionId}`);
    }
    if (log.events.length === 0) {
      log.firstSequence = event.sequence;
    }
    log.nextSequence = event.sequence + 1;
    if (idempotencyKey !== undefined) {
      this.rememberEventKey(key, idempotencyKey, event);
    }
    this.appendToLog(log, event);
  }

  private appendToLog(log: EventLog, event: AgentServerEvent): void {
    log.events.push(structuredClone(event));
    if (log.events.length > this.maxEventsPerSession) {
      const removeCount = log.events.length - this.maxEventsPerSession;
      log.events.splice(0, removeCount);
      log.firstSequence += removeCount;
    }
  }

  private getOrCreateEventLog(key: string): EventLog {
    const existing = this.eventLogs.get(key);
    if (existing) {
      return existing;
    }
    const created: EventLog = {
      firstSequence: 1,
      nextSequence: 1,
      events: [],
      waiters: new Set(),
    };
    this.eventLogs.set(key, created);
    return created;
  }
}
```

- [ ] **Step 5: 运行新旧测试确认通过**

Run: `pnpm vitest run src/server/__tests__/AgentServerStoreJournal.test.ts src/server/__tests__/AgentServerStore.test.ts src/server/__tests__/AgentServerStoreCommandAbandon.test.ts src/server/__tests__/AgentServer.integration.test.ts`
Expected: 全部通过。`AgentServerStore.ts` 行数保持在 900 以内（`wc -l` 应约 620 行）。

- [ ] **Step 6: lint 与提交**

```bash
pnpm lint:fix && pnpm lint && pnpm type-check
git add src/server/RuntimeStore.ts src/server/AgentServerStore.ts src/server/__tests__/AgentServerStoreJournal.test.ts
git commit -m "feat(server): journal, snapshot and restore for the in-memory store"
```

---

### Task 4: `JsonlAgentServerStore`、导出、stub、文档

**Files:**
- Create: `src/server/JsonlAgentServerStore.ts`
- Modify: `src/server/runtime.ts:5-11`（导出块）
- Modify: `src/browser/server-only-stub.ts`（在 `JsonlSessionRepository` stub 之后）
- Create: `src/server/__tests__/helpers/agentServerStoreContract.ts`
- Create: `src/server/__tests__/JsonlAgentServerStore.test.ts`
- Modify: `docs/server-runtime.md`（`## 存储职责` 末尾）、`docs/en/server-runtime.md`（`## Storage responsibilities` 末尾）
- Create: `.changes/jsonl-agent-server-store.json`

**Interfaces:**
- Consumes: Task 3 的 `InMemoryAgentServerStore` journal 选项、`restore`、`snapshot`、`AgentServerStoreJournalEntry`；`RuntimeStoreError` 与 `RUNTIME_STORE_CORRUPT_JOURNAL`。
- Produces（Task 6 依赖）：`new JsonlAgentServerStore({ directory, maxEventsPerSession?, now?, logger? })`，`await store.initialize()`，`await store.close()`，其余方法与 `AgentServerStore` 相同；从 `@blade-ai/agent-sdk/server/infra` 导出。

- [ ] **Step 1: 契约测试助手**

创建 `src/server/__tests__/helpers/agentServerStoreContract.ts`（把内存 store 已有的行为用例改成工厂形式，供两种 store 复用）：

```ts
import { expect, it } from 'vitest';
import { AGENT_PROTOCOL_VERSION } from '../../../protocol/index.js';
import { CommandId, SessionId } from '../../../types/identifiers.js';
import type { AgentServerStore } from '../../AgentServerStore.js';

export interface ContractStore extends AgentServerStore {
  trimAgentEventsForTesting(tenantId: string, sessionId: SessionId): Promise<void>;
  close?(): Promise<void>;
}

export type ContractStoreFactory = (options?: {
  now?: () => number;
  maxEventsPerSession?: number;
}) => Promise<ContractStore>;

export function describeAgentServerStoreContract(createStore: ContractStoreFactory): void {
  it('claims, fences, and replays idempotent command results', async () => {
    let now = 1000;
    const store = await createStore({ now: () => now });
    const claim = await store.claimCommand('tenant-a', CommandId('command-1'), 'fingerprint-1', 100);
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') return;

    await expect(
      store.claimCommand('tenant-a', CommandId('command-1'), 'fingerprint-1', 100),
    ).resolves.toMatchObject({ status: 'in_progress' });
    now += 101;
    const replacement = await store.claimCommand(
      'tenant-a',
      CommandId('command-1'),
      'fingerprint-1',
      100,
    );
    expect(replacement.status).toBe('claimed');
    if (replacement.status !== 'claimed') return;

    await expect(
      store.completeCommand('tenant-a', CommandId('command-1'), claim.leaseId, {
        protocolVersion: 1,
        commandId: CommandId('command-1'),
        ok: true,
        data: { stale: true },
      }),
    ).rejects.toThrow(/no longer active/i);

    const result = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      commandId: CommandId('command-1'),
      ok: true as const,
      data: { sessionId: 'session-1' },
    };
    await store.completeCommand('tenant-a', CommandId('command-1'), replacement.leaseId, result);
    await expect(
      store.claimCommand('tenant-a', CommandId('command-1'), 'fingerprint-1', 100),
    ).resolves.toEqual({ status: 'completed', result });
    await expect(
      store.claimCommand('tenant-a', CommandId('command-1'), 'fingerprint-2', 100),
    ).resolves.toEqual({ status: 'conflict' });
    await store.close?.();
  });

  it('keeps sealed commands fail-closed after their initial lease expires', async () => {
    let now = 1000;
    const store = await createStore({ now: () => now });
    const claim = await store.claimCommand('tenant-a', CommandId('command-1'), 'fingerprint-1', 100);
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') return;
    await store.sealCommand('tenant-a', CommandId('command-1'), claim.leaseId);
    await store.releaseCommand('tenant-a', CommandId('command-1'), claim.leaseId);

    now += 10_000;
    await expect(
      store.claimCommand('tenant-a', CommandId('command-1'), 'fingerprint-1', 100),
    ).resolves.toEqual({ status: 'in_progress', retryAfterMs: 1000 });
    await store.close?.();
  });

  it('isolates session ownership by tenant', async () => {
    const store = await createStore();
    const sessionId = SessionId('session-1');
    await store.putSession({
      tenantId: 'tenant-a',
      createdBy: 'user-a',
      sessionId,
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    await expect(store.getSession('tenant-a', sessionId)).resolves.toMatchObject({ sessionId });
    await expect(store.getSession('tenant-b', sessionId)).resolves.toBeNull();
    await store.close?.();
  });

  it('sequences retained events and rejects stale cursors', async () => {
    const store = await createStore({ maxEventsPerSession: 2 });
    const sessionId = SessionId('session-1');
    for (const delta of ['one', 'two', 'three']) {
      await store.appendEvent('tenant-a', sessionId, {
        protocolVersion: 1,
        sessionId,
        occurredAt: new Date().toISOString(),
        type: 'session.stream',
        data: { type: 'content', delta, sessionId },
      });
    }

    await expect(store.readEvents('tenant-a', sessionId, { after: 1 })).resolves.toMatchObject({
      events: [
        { sequence: 2, data: { delta: 'two' } },
        { sequence: 3, data: { delta: 'three' } },
      ],
    });
    await expect(store.readEvents('tenant-a', sessionId, { after: 0 })).rejects.toThrow(/stale/i);
    await store.close?.();
  });

  it('remembers idempotency keys after retention has dropped the original event', async () => {
    const store = await createStore();
    const sessionId = SessionId('session-idempotent');
    const event = {
      protocolVersion: 1,
      sessionId,
      occurredAt: new Date().toISOString(),
      type: 'session.stream',
      data: { type: 'result', subtype: 'success', content: 'done', sessionId },
    } as const;
    const first = await store.appendEvent('tenant-a', sessionId, event, {
      idempotencyKey: 'terminal-2',
    });
    await store.trimAgentEventsForTesting('tenant-a', sessionId);

    const repeat = await store.appendEvent('tenant-a', sessionId, event, {
      idempotencyKey: 'terminal-2',
    });
    expect(repeat.eventId).toBe(first.eventId);
    expect((await store.readEvents('tenant-a', sessionId)).events).toHaveLength(0);
    await expect(
      store.getEventByIdempotencyKey?.('tenant-a', sessionId, 'terminal-2'),
    ).resolves.toMatchObject({ eventId: first.eventId });
    await store.close?.();
  });

  it('wakes event subscribers without losing the append race', async () => {
    const store = await createStore();
    const sessionId = SessionId('session-1');
    const waiting = store.waitForEvents?.('tenant-a', sessionId, 0);
    await store.appendEvent('tenant-a', sessionId, {
      protocolVersion: 1,
      sessionId,
      occurredAt: new Date().toISOString(),
      type: 'session.closed',
      data: {},
    });
    await expect(waiting).resolves.toBeUndefined();
    await store.close?.();
  });
}
```

- [ ] **Step 2: 写文件 store 的失败测试**

创建 `src/server/__tests__/JsonlAgentServerStore.test.ts`：

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_PROTOCOL_VERSION } from '../../protocol/index.js';
import { CommandId, SessionId } from '../../types/identifiers.js';
import { JsonlAgentServerStore } from '../JsonlAgentServerStore.js';
import { RuntimeStoreError } from '../RuntimeStore.js';
import { describeAgentServerStoreContract } from './helpers/agentServerStoreContract.js';

const tenantId = 'tenant-jsonl';
const sessionId = SessionId('session-jsonl');

async function directory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'jsonl-agent-server-store-'));
}

function record() {
  return {
    tenantId,
    createdBy: 'user-a',
    sessionId,
    status: 'active' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function event(delta: string) {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    sessionId,
    occurredAt: '2026-01-01T00:00:00.000Z',
    type: 'session.stream' as const,
    data: { type: 'content' as const, delta, sessionId },
  };
}

const sessionLine = `${JSON.stringify({ v: 1, kind: 'session', record: record() })}\n`;

describe('JsonlAgentServerStore contract', () => {
  describeAgentServerStoreContract(async (options = {}) => {
    const store = new JsonlAgentServerStore({ directory: await directory(), ...options });
    await store.initialize();
    return store;
  });
});

describe('JsonlAgentServerStore persistence', () => {
  it('replays sessions, events, idempotency keys and sealed leases after a restart', async () => {
    const dir = await directory();
    let now = 1000;
    const first = new JsonlAgentServerStore({ directory: dir, maxEventsPerSession: 2, now: () => now });
    await first.initialize();
    await first.putSession(record());
    const claim = await first.claimCommand(tenantId, CommandId('sealed'), 'fp', 100);
    if (claim.status !== 'claimed') throw new Error('expected a claim');
    await first.sealCommand(tenantId, CommandId('sealed'), claim.leaseId);
    const keyed = await first.appendEvent(tenantId, sessionId, event('one'), {
      idempotencyKey: 'terminal',
    });
    await first.appendEvent(tenantId, sessionId, event('two'));
    await first.appendEvent(tenantId, sessionId, event('three'));
    await first.close();

    const second = new JsonlAgentServerStore({ directory: dir, maxEventsPerSession: 2, now: () => now });
    await second.initialize();
    now += 10_000;
    await expect(second.getSession(tenantId, sessionId)).resolves.toMatchObject({ sessionId });
    await expect(second.getEventStreamRange(tenantId, sessionId)).resolves.toEqual({
      firstSequence: 2,
      headSequence: 3,
    });
    await expect(second.readEvents(tenantId, sessionId, { after: 1 })).resolves.toMatchObject({
      events: [{ sequence: 2 }, { sequence: 3 }],
    });
    await expect(second.getEventByIdempotencyKey(tenantId, sessionId, 'terminal')).resolves.toMatchObject(
      { eventId: keyed.eventId },
    );
    await expect(second.claimCommand(tenantId, CommandId('sealed'), 'fp', 100)).resolves.toEqual({
      status: 'in_progress',
      retryAfterMs: 1000,
    });
    const next = await second.appendEvent(tenantId, sessionId, event('four'));
    expect(next.sequence).toBe(4);
    await second.close();
  });

  it('compacts the journal on initialize', async () => {
    const dir = await directory();
    const first = new JsonlAgentServerStore({ directory: dir, maxEventsPerSession: 2 });
    await first.initialize();
    await first.putSession(record());
    for (const delta of ['one', 'two', 'three', 'four']) {
      await first.appendEvent(tenantId, sessionId, event(delta));
    }
    await first.close();
    const before = (await readFile(join(dir, 'server-store.jsonl'), 'utf8')).split('\n').filter(Boolean);
    expect(before).toHaveLength(5);

    const second = new JsonlAgentServerStore({ directory: dir, maxEventsPerSession: 2 });
    await second.initialize();
    await second.close();
    const after = (await readFile(join(dir, 'server-store.jsonl'), 'utf8')).split('\n').filter(Boolean);
    expect(after).toHaveLength(3);
    expect(after.map((line) => (JSON.parse(line) as { kind: string }).kind)).toEqual([
      'session',
      'event',
      'event',
    ]);
  });

  it('tolerates a truncated last line and drops it on compaction', async () => {
    const dir = await directory();
    await writeFile(join(dir, 'server-store.jsonl'), `${sessionLine}{"v":1,"kind":"event","tenantId":"ten`);
    const store = new JsonlAgentServerStore({ directory: dir });
    await store.initialize();
    await expect(store.getSession(tenantId, sessionId)).resolves.toMatchObject({ sessionId });
    await store.close();
    expect(await readFile(join(dir, 'server-store.jsonl'), 'utf8')).toBe(sessionLine);
  });

  it('rejects a corrupt line with its line number', async () => {
    const dir = await directory();
    await writeFile(join(dir, 'server-store.jsonl'), `${sessionLine}not json\n${sessionLine}`);
    const store = new JsonlAgentServerStore({ directory: dir });
    const failure = await store.initialize().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RuntimeStoreError);
    expect(failure).toMatchObject({ code: 'RUNTIME_STORE_CORRUPT_JOURNAL' });
    expect((failure as Error).message).toContain('server-store.jsonl:2');
  });

  it('rejects an unknown journal version', async () => {
    const dir = await directory();
    await writeFile(join(dir, 'server-store.jsonl'), `${JSON.stringify({ v: 2, kind: 'session', record: record() })}\n`);
    const store = new JsonlAgentServerStore({ directory: dir });
    await expect(store.initialize()).rejects.toMatchObject({ code: 'RUNTIME_STORE_CORRUPT_JOURNAL' });
  });

  it('requires initialize() and rejects writes after close()', async () => {
    const dir = await directory();
    const store = new JsonlAgentServerStore({ directory: dir });
    await expect(store.putSession(record())).rejects.toThrow(/initialize/i);
    await store.initialize();
    await store.putSession(record());
    await store.close();
    await expect(store.putSession(record())).rejects.toThrow(/closed/i);
    await expect(store.healthCheck()).resolves.toMatchObject({ ready: false });
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm vitest run src/server/__tests__/JsonlAgentServerStore.test.ts`
Expected: 模块 `../JsonlAgentServerStore.js` 不存在，整文件失败。

- [ ] **Step 4: 实现 `JsonlAgentServerStore`**

创建 `src/server/JsonlAgentServerStore.ts`：

```ts
import { existsSync } from 'node:fs';
import { type FileHandle, mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { createRootLogger, type InternalLogger } from '../logging/Logger.js';
import type { AgentCommandResult, AgentEventPage, AgentServerEvent } from '../protocol/index.js';
import type { CommandId, ExecutionLeaseId, SessionId } from '../types/identifiers.js';
import type { JsonObject } from '../types/json.js';
import type { AgentLogger } from '../types/logging.js';
import {
  type AgentCommandClaim,
  type AgentServerSessionRecord,
  type AgentServerStore,
  type AgentServerStoreJournalEntry,
  InMemoryAgentServerStore,
} from './AgentServerStore.js';
import { RuntimeStoreError } from './RuntimeStore.js';

const JOURNAL_FILE = 'server-store.jsonl';
const JOURNAL_VERSION = 1;
const ENTRY_KINDS: ReadonlySet<string> = new Set(['session', 'event', 'event_key', 'lease']);

export interface JsonlAgentServerStoreOptions {
  /** Directory that owns `server-store.jsonl`; created when missing. */
  readonly directory: string;
  readonly maxEventsPerSession?: number;
  readonly now?: () => number;
  readonly logger?: AgentLogger;
}

type JournalLine = AgentServerStoreJournalEntry & { readonly v: number };

function serialize(entry: AgentServerStoreJournalEntry): string {
  return `${JSON.stringify({ v: JOURNAL_VERSION, ...entry })}\n`;
}

function isJournalLine(value: unknown): value is JournalLine {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { v?: unknown }).v === JOURNAL_VERSION &&
    ENTRY_KINDS.has(String((value as { kind?: unknown }).kind))
  );
}

/**
 * Single-process `AgentServerStore` that journals every change to one JSONL
 * file and replays it on start. It keeps the in-memory store's semantics
 * (idempotent appends, retention, fail-closed sealed leases) and adds restart
 * durability for one server process. Multi-instance deployments still need
 * the PostgreSQL store.
 */
export class JsonlAgentServerStore implements AgentServerStore {
  private readonly directory: string;
  private readonly filePath: string;
  private readonly logger: InternalLogger;
  private readonly inner: InMemoryAgentServerStore;
  private handle: FileHandle | undefined;
  private queue: Promise<void> = Promise.resolve();
  private state: 'new' | 'ready' | 'closed' = 'new';

  constructor(options: JsonlAgentServerStoreOptions) {
    this.directory = options.directory;
    this.filePath = join(options.directory, JOURNAL_FILE);
    this.logger = createRootLogger(options.logger ?? null);
    this.inner = new InMemoryAgentServerStore({
      ...(options.maxEventsPerSession !== undefined
        ? { maxEventsPerSession: options.maxEventsPerSession }
        : {}),
      ...(options.now ? { now: options.now } : {}),
      journal: { append: (entry) => this.write(entry) },
    });
  }

  /** Replays the journal, rewrites it compacted, then opens it for appends. */
  async initialize(): Promise<void> {
    if (this.state === 'ready') {
      return;
    }
    if (this.state === 'closed') {
      throw new Error('JsonlAgentServerStore is closed');
    }
    await mkdir(this.directory, { recursive: true });
    if (existsSync(this.filePath)) {
      this.inner.restore(this.parse(await readFile(this.filePath, 'utf8')));
    }
    await writeFileAtomic(this.filePath, this.inner.snapshot().map(serialize).join(''));
    this.handle = await open(this.filePath, 'a');
    this.state = 'ready';
  }

  async close(): Promise<void> {
    if (this.state !== 'ready') {
      this.state = 'closed';
      return;
    }
    this.state = 'closed';
    await this.queue;
    const handle = this.handle;
    this.handle = undefined;
    await handle?.close();
  }

  async healthCheck(): Promise<{ ready: boolean; details?: JsonObject }> {
    const inner = await this.inner.healthCheck();
    return {
      ready: inner.ready && this.state === 'ready',
      details: { ...(inner.details ?? {}), directory: this.directory, state: this.state },
    };
  }

  async claimCommand(
    tenantId: string,
    commandId: CommandId,
    commandFingerprint: string,
    ttlMs: number,
  ): Promise<AgentCommandClaim> {
    this.assertReady();
    return this.inner.claimCommand(tenantId, commandId, commandFingerprint, ttlMs);
  }

  async sealCommand(tenantId: string, commandId: CommandId, leaseId: ExecutionLeaseId): Promise<void> {
    this.assertReady();
    return this.inner.sealCommand(tenantId, commandId, leaseId);
  }

  async completeCommand(
    tenantId: string,
    commandId: CommandId,
    leaseId: ExecutionLeaseId,
    result: AgentCommandResult,
  ): Promise<void> {
    this.assertReady();
    return this.inner.completeCommand(tenantId, commandId, leaseId, result);
  }

  async releaseCommand(tenantId: string, commandId: CommandId, leaseId: ExecutionLeaseId): Promise<void> {
    this.assertReady();
    return this.inner.releaseCommand(tenantId, commandId, leaseId);
  }

  async abandonCommand(tenantId: string, commandId: CommandId, reason: string): Promise<boolean> {
    this.assertReady();
    return this.inner.abandonCommand(tenantId, commandId, reason);
  }

  async putSession(record: AgentServerSessionRecord): Promise<void> {
    this.assertReady();
    return this.inner.putSession(record);
  }

  async getSession(tenantId: string, sessionId: SessionId): Promise<AgentServerSessionRecord | null> {
    this.assertReady();
    return this.inner.getSession(tenantId, sessionId);
  }

  async listSessions(
    tenantId: string,
    options?: { cursor?: string; limit?: number },
  ): Promise<{ sessions: AgentServerSessionRecord[]; nextCursor?: string }> {
    this.assertReady();
    return this.inner.listSessions(tenantId, options);
  }

  async appendEvent(
    tenantId: string,
    sessionId: SessionId,
    event: Omit<AgentServerEvent, 'eventId' | 'sequence'>,
    options?: { readonly idempotencyKey?: string },
  ): Promise<AgentServerEvent> {
    this.assertReady();
    return this.inner.appendEvent(tenantId, sessionId, event, options);
  }

  async getEventByIdempotencyKey(
    tenantId: string,
    sessionId: SessionId,
    idempotencyKey: string,
  ): Promise<AgentServerEvent | null> {
    this.assertReady();
    return this.inner.getEventByIdempotencyKey(tenantId, sessionId, idempotencyKey);
  }

  async readEvents(
    tenantId: string,
    sessionId: SessionId,
    options?: { after?: number; limit?: number },
  ): Promise<AgentEventPage> {
    this.assertReady();
    return this.inner.readEvents(tenantId, sessionId, options);
  }

  async getLatestEventSequence(tenantId: string, sessionId: SessionId): Promise<number | null> {
    this.assertReady();
    return this.inner.getLatestEventSequence(tenantId, sessionId);
  }

  async getEventStreamRange(
    tenantId: string,
    sessionId: SessionId,
  ): Promise<{ readonly firstSequence: number; readonly headSequence: number } | null> {
    this.assertReady();
    return this.inner.getEventStreamRange(tenantId, sessionId);
  }

  async waitForEvents(
    tenantId: string,
    sessionId: SessionId,
    after: number,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertReady();
    return this.inner.waitForEvents(tenantId, sessionId, after, signal);
  }

  /** Test hook: drop retained events without touching the idempotency records. */
  async trimAgentEventsForTesting(tenantId: string, sessionId: SessionId): Promise<void> {
    this.assertReady();
    return this.inner.trimAgentEventsForTesting(tenantId, sessionId);
  }

  private assertReady(): void {
    if (this.state === 'new') {
      throw new Error('JsonlAgentServerStore.initialize() must be awaited before use');
    }
    if (this.state === 'closed') {
      throw new Error('JsonlAgentServerStore is closed');
    }
  }

  private write(entry: AgentServerStoreJournalEntry): Promise<void> {
    const handle = this.handle;
    if (!handle || this.state !== 'ready') {
      return Promise.reject(new Error('JsonlAgentServerStore is closed'));
    }
    const line = serialize(entry);
    const next = this.queue.then(async () => {
      await handle.write(line);
    });
    // Keep the chain alive after a failure so later writes and close() still drain.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private parse(text: string): AgentServerStoreJournalEntry[] {
    const hasTrailingNewline = text.endsWith('\n');
    const lines = text.split('\n');
    if (hasTrailingNewline) {
      lines.pop();
    }
    const entries: AgentServerStoreJournalEntry[] = [];
    lines.forEach((line, index) => {
      if (line === '') {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        if (index === lines.length - 1 && !hasTrailingNewline) {
          this.logger.warn(
            `[JsonlAgentServerStore] dropping the truncated last line of ${this.filePath}`,
          );
          return;
        }
        throw this.corrupt(index + 1, 'is not valid JSON', error);
      }
      if (!isJournalLine(parsed)) {
        throw this.corrupt(index + 1, 'is not a known journal entry');
      }
      // `v` stays on the object; restore() only reads `kind` and the payload fields.
      entries.push(parsed as AgentServerStoreJournalEntry);
    });
    return entries;
  }

  private corrupt(line: number, reason: string, cause?: unknown): RuntimeStoreError {
    return new RuntimeStoreError(
      'RUNTIME_STORE_CORRUPT_JOURNAL',
      `${this.filePath}:${line} ${reason}. Delete the directory to start from an empty store.`,
      cause === undefined ? undefined : { cause },
    );
  }
}
```

- [ ] **Step 5: 导出与 stub**

`src/server/runtime.ts` 第 5-11 行的导出块改为：

```ts
export {
  type AgentCommandClaim,
  type AgentServerSessionRecord,
  type AgentServerStore,
  type AgentServerStoreJournal,
  type AgentServerStoreJournalEntry,
  type CommandLeaseSnapshot,
  InMemoryAgentServerStore,
  type InMemoryAgentServerStoreOptions,
} from './AgentServerStore.js';
export {
  JsonlAgentServerStore,
  type JsonlAgentServerStoreOptions,
} from './JsonlAgentServerStore.js';
```

`src/browser/server-only-stub.ts` 在 `export class JsonlSessionRepository { ... }` 之后追加：

```ts
export class JsonlAgentServerStore {
  constructor(..._args: unknown[]) {
    serverOnly('JsonlAgentServerStore');
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `pnpm vitest run src/server/__tests__/JsonlAgentServerStore.test.ts src/server/__tests__/AgentServerStoreJournal.test.ts src/__tests__/packageEntrypoints.test.ts src/__tests__/rootExports.test.ts`
Expected: 全部通过。若 `packageEntrypoints`/`rootExports` 有导出快照断言，把 `JsonlAgentServerStore` 加进预期列表（读测试文件里的列表后同位置添加）。

- [ ] **Step 7: 文档**

`docs/server-runtime.md` 的 `## 存储职责` 一节末尾（“SDK 附带的 `InMemoryAgentServerStore` 只用于单进程和测试……” 段落之后）追加：

```markdown
### 单进程文件 store

`JsonlAgentServerStore` 把会话记录、事件日志、幂等键和命令租约追加写入
`<directory>/server-store.jsonl`，启动时回放并压缩。它保留内存 store 的全部
语义，只多了“同一台机器上重启后会话还在”。适合本地开发、demo 和单实例部署；
多实例仍然需要 PostgreSQL store。

```ts
import { AgentServer, JsonlAgentServerStore } from '@blade-ai/agent-sdk/server/infra';

const store = new JsonlAgentServerStore({ directory: '.blade/server' });
await store.initialize();
const server = new AgentServer({ store, resolveSessionOptions });
// 退出前
await server.close();
await store.close();
```

写入在方法 resolve 之前交给操作系统，进程崩溃不丢已确认的写入；每次写不做 fsync。
日志最后一行若被截断会被跳过并告警，其他损坏会让 `initialize()` 以
`RUNTIME_STORE_CORRUPT_JOURNAL` 失败，错误信息带行号；删除该目录即可从空 store 开始，
会话转录（`JsonlSessionRepository`）不受影响。Session 自身的转录仍需通过
`sessionRepository` / `sessionEventStore` 配置持久化，两者放在不同目录。
```

`docs/en/server-runtime.md` 的 `## Storage responsibilities` 末尾追加对应英文：

```markdown
### Single-process file store

`JsonlAgentServerStore` appends session records, the event log, idempotency
keys and command leases to `<directory>/server-store.jsonl`, replaying and
compacting it on start. It keeps every semantic of the in-memory store and adds
one thing: Sessions survive a restart of the same process on the same machine.
Use it for local development, demos and single-instance deployments; multiple
instances still need the PostgreSQL store.

```ts
import { AgentServer, JsonlAgentServerStore } from '@blade-ai/agent-sdk/server/infra';

const store = new JsonlAgentServerStore({ directory: '.blade/server' });
await store.initialize();
const server = new AgentServer({ store, resolveSessionOptions });
// on exit
await server.close();
await store.close();
```

Writes reach the operating system before the mutating call resolves, so a
process crash keeps every acknowledged write; there is no fsync per write. A
truncated last line is skipped with a warning; any other damage fails
`initialize()` with `RUNTIME_STORE_CORRUPT_JOURNAL` and a line number. Delete
the directory to start from an empty store; Session transcripts kept by
`JsonlSessionRepository` live elsewhere and are not affected. Transcripts still
need `sessionRepository` / `sessionEventStore` configured separately.
```

- [ ] **Step 8: fragment、lint、docs 构建、提交**

创建 `.changes/jsonl-agent-server-store.json`：

```json
{
  "type": "feature",
  "en": "Add JsonlAgentServerStore, a single-process file-backed AgentServer store that replays its journal on restart, plus journal, snapshot and restore support on InMemoryAgentServerStore.",
  "zh-CN": "新增 JsonlAgentServerStore：单进程文件持久化的 AgentServer store，重启时回放日志；InMemoryAgentServerStore 同时获得日志、快照与恢复能力。"
}
```

```bash
pnpm lint:fix && pnpm lint && pnpm type-check && pnpm docs:build && pnpm changelog:check
git add src/server/JsonlAgentServerStore.ts src/server/runtime.ts src/browser/server-only-stub.ts src/server/__tests__/helpers/agentServerStoreContract.ts src/server/__tests__/JsonlAgentServerStore.test.ts docs/server-runtime.md docs/en/server-runtime.md .changes/jsonl-agent-server-store.json
git commit -m "feat(server): add the JSONL AgentServer store"
```

---

### Task 5: 脚本化 provider `DemoProvider.mjs`

**Files:**
- Create: `examples/web-agent-server/DemoProvider.mjs`
- Create: `examples/web-agent-server/DemoProvider.test.mjs`（用 `node --test` 跑，不进 vitest）

**Interfaces:**
- Consumes: `ProviderRegistry` 来自 `@blade-ai/agent-sdk`；provider 适配器接口 `chat` / `sideQuery` / `streamChat` / `getConfig` / `updateConfig`，工具调用形如 `{ content: '', toolCalls: [{ id, type: 'function', function: { name, arguments } }] }`，流式块可带 `reasoningContent`。
- Produces（Task 6 与 smoke 依赖）：
  - `createDemoProviderRegistry({ root, smoke }): ProviderRegistry`
  - 常量 `DEMO_PROVIDER_TYPE`、`DEMO_MODEL`、`REPORT_TITLE`、`SECURITY_SECTION`、`CONTINUATION_PREFIX`、`NPM_CACHE_FLAG`
  - `nextStep(messages, root)`、`analyzeConversation(messages)`、`textOf(content)`（smoke 与测试使用）

- [ ] **Step 1: 写失败测试**

创建 `examples/web-agent-server/DemoProvider.test.mjs`：

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeConversation,
  CONTINUATION_PREFIX,
  nextStep,
  REPORT_TITLE,
  SECURITY_SECTION,
} from './DemoProvider.mjs';

const root = '/workspace/demo';
const user = (content) => ({ role: 'user', content });
const assistantCall = (id, name, args) => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const toolResult = (id, content) => ({ role: 'tool', tool_call_id: id, content });
const toolName = (step) => step.response.toolCalls?.[0]?.function.name;

const globText = 'Found 1 file(s) matching:\n\n- package.json\n';
const manifest = JSON.stringify({
  name: 'demo',
  dependencies: { 'left-pad': '^1.3.0', 'is-odd': '*' },
  devDependencies: { vitest: '3.0.0' },
});
const bashText = JSON.stringify({ stdout: JSON.stringify({ problems: ['missing: left-pad@^1.3.0'] }), stderr: '', exit_code: 1 });

test('follows the script: Glob, Read, Bash, then a report', () => {
  const messages = [user('Analyze this project')];
  assert.equal(toolName(nextStep(messages, root)), 'Glob');
  messages.push(assistantCall('c1', 'Glob', {}), toolResult('c1', globText));
  assert.equal(toolName(nextStep(messages, root)), 'Read');
  messages.push(assistantCall('c2', 'Read', {}), toolResult('c2', manifest));
  assert.equal(toolName(nextStep(messages, root)), 'Bash');
  messages.push(assistantCall('c3', 'Bash', {}), toolResult('c3', bashText));
  const report = nextStep(messages, root).response.content;
  assert.match(report, new RegExp(REPORT_TITLE));
  assert.match(report, /Direct dependencies: 3/);
  assert.match(report, /Unpinned version ranges: 2/);
  assert.match(report, /Lockfile: missing/);
  assert.match(report, /npm ls reported 1 problem/);
  assert.doesNotMatch(report, new RegExp(SECURITY_SECTION));
});

test('a second user message mid-task switches to the security branch', () => {
  const messages = [
    user('Analyze this project'),
    assistantCall('c1', 'Glob', {}),
    toolResult('c1', globText),
    user('Focus on security issues'),
  ];
  assert.equal(analyzeConversation(messages).phase, 'steered');
  assert.equal(toolName(nextStep(messages, root)), 'Grep');
  messages.push(assistantCall('c2', 'Grep', {}), toolResult('c2', 'package.json:9:    "postinstall": "node ./setup.js"\n'));
  const report = nextStep(messages, root).response.content;
  assert.match(report, new RegExp(SECURITY_SECTION));
  assert.match(report, /matches: 1/);
});

test('a new user message after a report continues without tools', () => {
  const messages = [
    user('Analyze this project'),
    { role: 'assistant', content: `${REPORT_TITLE} for demo\n\n- Direct dependencies: 3 (2 runtime, 1 dev)` },
    user('Continue the analysis'),
  ];
  assert.equal(analyzeConversation(messages).phase, 'continue');
  const step = nextStep(messages, root);
  assert.equal(step.response.toolCalls, undefined);
  assert.match(step.response.content, new RegExp(`${CONTINUATION_PREFIX} \\(3 dependencies reviewed\\)`));
});

test('reports a missing manifest instead of reading it', () => {
  const messages = [user('Analyze'), assistantCall('c1', 'Glob', {}), toolResult('c1', 'No files found')];
  const step = nextStep(messages, root);
  assert.equal(step.response.toolCalls, undefined);
  assert.match(step.response.content, /No Node manifest/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test examples/web-agent-server/DemoProvider.test.mjs`
Expected: 模块不存在，失败。

- [ ] **Step 3: 实现 provider**

创建 `examples/web-agent-server/DemoProvider.mjs`：

```js
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProviderRegistry } from '@blade-ai/agent-sdk';

export const DEMO_PROVIDER_TYPE = 'web-starter-demo';
export const DEMO_MODEL = 'web-starter-demo';
export const REPORT_TITLE = 'Dependency risk report';
export const SECURITY_SECTION = 'Focus adjusted: security';
export const CONTINUATION_PREFIX = 'Continuing from the saved analysis';
export const NPM_CACHE_FLAG = '--cache /tmp/blade-npm-cache';

const UNPINNED_RANGE = /^(\^|~|\*$|latest$|>|<|x$)/;
const SECURITY_PATTERN = 'postinstall|preinstall|eval\\(|child_process';

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text')
      .map((part) => part.text)
      .join('');
  }
  return '';
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Tool calls made after `startIndex`, paired with the results the runtime returned. */
function toolResults(messages, startIndex) {
  const calls = new Map();
  const results = [];
  for (const message of messages.slice(startIndex)) {
    for (const call of message.tool_calls ?? []) {
      calls.set(call.id, {
        name: call.function.name,
        args: parseJson(call.function.arguments) ?? {},
      });
    }
    if (message.role === 'tool') {
      const call = calls.get(message.tool_call_id);
      if (call) results.push({ ...call, text: textOf(message.content) });
    }
  }
  return results;
}

/**
 * The provider is stateless: every call reads the conversation and decides the
 * next step. Order matters: a prior report means "continue"; a second user
 * message inside the current task means "steered"; otherwise follow the script.
 */
export function analyzeConversation(messages) {
  const reportIndex = messages.findLastIndex(
    (message) => message.role === 'assistant' && textOf(message.content).includes(REPORT_TITLE),
  );
  const lastUserIndex = messages.findLastIndex((message) => message.role === 'user');
  if (reportIndex !== -1 && lastUserIndex > reportIndex) {
    return { phase: 'continue', report: textOf(messages[reportIndex].content) };
  }
  const taskStart = reportIndex === -1 ? 0 : reportIndex + 1;
  const users = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message, index }) => message.role === 'user' && index >= taskStart);
  const steered = users.length >= 2;
  return {
    phase: steered ? 'steered' : 'script',
    steeringText: steered ? textOf(users.at(-1).message.content) : '',
    results: toolResults(messages, taskStart),
  };
}

function call(name, args, reasoning) {
  return {
    reasoning,
    response: {
      content: '',
      toolCalls: [
        {
          id: `demo-${randomUUID()}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
  };
}

function text(content, reasoning) {
  return { reasoning, response: { content } };
}

function latest(results, name) {
  return results.findLast((result) => result.name === name);
}

function globFiles(globText) {
  return (globText ?? '')
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());
}

function parseManifest(readText) {
  const manifest = parseJson(readText ?? '');
  return manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : undefined;
}

function unpinnedRanges(manifest) {
  return Object.entries({ ...(manifest?.dependencies ?? {}), ...(manifest?.devDependencies ?? {}) })
    .filter(([, range]) => typeof range === 'string' && UNPINNED_RANGE.test(range.trim()))
    .map(([name, range]) => `${name}@${range}`);
}

function npmLsSummary(bashText) {
  if (!bashText) return 'npm ls was not run';
  const result = parseJson(bashText);
  if (!result || typeof result !== 'object') return `npm ls did not return JSON: ${bashText.slice(0, 120)}`;
  const tree = parseJson(result.stdout ?? '');
  if (!tree) {
    const firstError = String(result.stderr ?? '').trim().split('\n')[0];
    return `npm ls exited ${result.exit_code ?? 'unknown'} without JSON output${firstError ? `: ${firstError}` : ''}`;
  }
  const problems = Array.isArray(tree.problems) ? tree.problems : [];
  return problems.length === 0
    ? 'npm ls: the installed tree matches the manifest'
    : `npm ls reported ${problems.length} problem(s), first: ${problems[0]}`;
}

function buildReport(results, root, steeringText = '') {
  const manifest = parseManifest(latest(results, 'Read')?.text);
  const files = globFiles(latest(results, 'Glob')?.text);
  const lockfile = files.find((file) => /lock/i.test(file));
  const runtimeDeps = Object.keys(manifest?.dependencies ?? {});
  const devDeps = Object.keys(manifest?.devDependencies ?? {});
  const ranges = unpinnedRanges(manifest);
  const lines = [
    `${REPORT_TITLE} for ${basename(root)}`,
    '',
    `- Direct dependencies: ${runtimeDeps.length + devDeps.length} (${runtimeDeps.length} runtime, ${devDeps.length} dev)`,
    `- Unpinned version ranges: ${ranges.length}${ranges.length ? ` (${ranges.slice(0, 6).join(', ')}${ranges.length > 6 ? ', ...' : ''})` : ''}`,
    `- Lockfile: ${lockfile ? `present (${lockfile})` : 'missing, installs are not reproducible'}`,
    `- engines.node: ${manifest?.engines?.node ?? 'not declared'}`,
    `- ${npmLsSummary(latest(results, 'Bash')?.text)}`,
  ];
  if (steeringText) {
    const grepText = latest(results, 'Grep')?.text ?? '';
    const matches = grepText.split('\n').filter((line) => /:\d+:/.test(line));
    lines.push(
      '',
      SECURITY_SECTION,
      `- Requested mid-run: "${steeringText}"`,
      `- Install hooks or dynamic execution matches: ${matches.length}`,
      ...matches.slice(0, 5).map((line) => `  ${line.trim()}`),
    );
  }
  lines.push(
    '',
    'Next steps:',
    ranges.length
      ? '- Pin the ranges above or commit a lockfile before the next release.'
      : '- Keep ranges pinned and review updates through the lockfile.',
    lockfile
      ? '- Run `npm audit` against the lockfile in CI.'
      : '- Generate a lockfile with `npm install --package-lock-only` and commit it.',
  );
  return lines.join('\n');
}

function continuation(report) {
  const reviewed = /Direct dependencies: (\d+)/.exec(report)?.[1] ?? 'the';
  return [
    `${CONTINUATION_PREFIX} (${reviewed} dependencies reviewed).`,
    '',
    'Two follow-ups from that report:',
    '1. Pin any unpinned ranges and commit the lockfile, then re-run this analysis.',
    '2. Add `npm audit --omit=dev` to CI so new advisories fail the build instead of waiting for a manual review.',
  ].join('\n');
}

export function nextStep(messages, root) {
  const state = analyzeConversation(messages);
  if (state.phase === 'continue') {
    return text(continuation(state.report), 'The saved report is already in the transcript; extending it without new tool calls');
  }
  const { results } = state;
  if (state.phase === 'steered') {
    if (!latest(results, 'Grep')) {
      return call(
        'Grep',
        { pattern: SECURITY_PATTERN, path: root, output_mode: 'content' },
        `Focus changed: "${state.steeringText}". Scanning for install hooks and dynamic execution`,
      );
    }
    return text(buildReport(results, root, state.steeringText), 'Evidence collected; writing the security-focused report');
  }
  const glob = latest(results, 'Glob');
  if (!glob) {
    return call(
      'Glob',
      { pattern: '{package.json,package-lock.json,pnpm-lock.yaml,yarn.lock,bun.lock}', path: root },
      'Locating the manifest and lockfiles',
    );
  }
  if (!globFiles(glob.text).includes('package.json')) {
    return text(
      `${REPORT_TITLE} for ${basename(root)}\n\nNo Node manifest found under ${root}: nothing named package.json matched, so there are no dependencies to assess. Point --root at a Node project to analyze it.`,
      'No package.json here; reporting that instead of guessing',
    );
  }
  if (!latest(results, 'Read')) {
    return call('Read', { file_path: join(root, 'package.json') }, 'Reading package.json');
  }
  if (!latest(results, 'Bash')) {
    return call(
      'Bash',
      { command: `npm ls --depth=0 --json ${NPM_CACHE_FLAG}` },
      'Checking the installed dependency tree offline',
    );
  }
  return text(buildReport(results, root), 'Evidence collected; writing the report');
}

export function createDemoProviderRegistry({ root, smoke = false }) {
  const pace = smoke ? 20 : 450;
  const chunkPace = smoke ? 5 : 40;
  return new ProviderRegistry([
    {
      type: DEMO_PROVIDER_TYPE,
      create(config) {
        return {
          async chat(messages, _tools, signal) {
            signal?.throwIfAborted();
            return nextStep(messages, root).response;
          },
          async sideQuery(_messages, signal) {
            signal?.throwIfAborted();
            return { content: `Analyze dependency risks under ${root} with Glob, Read, Bash and Grep.` };
          },
          async *streamChat(messages, _tools, signal) {
            signal?.throwIfAborted();
            const step = nextStep(messages, root);
            yield { reasoningContent: `${step.reasoning}.` };
            await delay(pace, undefined, { signal });
            if (step.response.toolCalls) {
              yield step.response;
            } else {
              for (const chunk of step.response.content.match(/[^]{1,48}/g) ?? ['']) {
                signal?.throwIfAborted();
                yield { content: chunk };
                await delay(chunkPace, undefined, { signal });
              }
            }
            yield {
              finishReason: step.response.toolCalls ? 'tool_calls' : 'stop',
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            };
          },
          getConfig() {
            return config;
          },
          updateConfig() {},
        };
      },
    },
  ]);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test examples/web-agent-server/DemoProvider.test.mjs`
Expected: 4 passed。

- [ ] **Step 5: 提交**

```bash
git add examples/web-agent-server/DemoProvider.mjs examples/web-agent-server/DemoProvider.test.mjs
git commit -m "feat(examples): scripted repository-analysis provider for the web starter"
```

---

### Task 6: `server.mjs` 重写与 9 步 smoke

**Files:**
- Modify: `examples/web-agent-server/server.mjs`（整体重写）
- Create: `examples/web-agent-server/smoke.mjs`
- Modify: `package.json`（无需改 scripts，`example:web` 已是 `pnpm run build && node examples/web-agent-server/server.mjs`）

**Interfaces:**
- Consumes: Task 1 `permissions`、Task 4 `JsonlAgentServerStore`、Task 5 的 provider 与常量；`JsonlSessionRepository` 与 `getSandboxExecutor` 来自 `@blade-ai/agent-sdk/advanced`；`AgentClient` 来自 `@blade-ai/agent-sdk/browser`。
- Produces（Task 7、Task 8 依赖）：
  - 命令行：`--smoke`、`--port <n>`、`--root <dir>`、`--data-dir <dir>`、`--no-open`
  - 三个脚手架替换锚点必须原样存在：`const webRoot = root;`、`const projectRoot = root;`
  - smoke 输出 JSON 含 `"continuationRestored": true`（Task 8 的 verify 脚本以此为期望输出）
  - `smoke.mjs` 导出 `createSmokeFixture()` 与 `runSmoke({ baseUrl, startedAt, budgetMs, restart })`

- [ ] **Step 1: 写 `smoke.mjs`**

创建 `examples/web-agent-server/smoke.mjs`：

```js
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentClient } from '@blade-ai/agent-sdk/browser';
import { CONTINUATION_PREFIX, REPORT_TITLE, SECURITY_SECTION, textOf } from './DemoProvider.mjs';

const TASK = "Analyze this project's dependency risks";
const STEER = 'Focus on security issues';
const CONTINUE = 'Continue the analysis';

/** A throwaway Node project with two unpinned ranges, no lockfile and a postinstall hook. */
export async function createSmokeFixture() {
  const base = await mkdtemp(join(tmpdir(), 'blade-web-smoke-'));
  const root = join(base, 'workspace');
  const dataDir = join(base, 'data');
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'smoke-fixture',
        version: '0.0.1',
        private: true,
        scripts: { postinstall: 'node ./setup.js' },
        dependencies: { 'left-pad': '^1.3.0', 'is-odd': '*' },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, 'setup.js'), "console.log('setup');\n");
  return { root, dataDir, cleanup: () => rm(base, { recursive: true, force: true }) };
}

function hasReport(messages) {
  return (messages ?? []).some(
    (message) => message.role === 'assistant' && textOf(message.content).includes(REPORT_TITLE),
  );
}

export async function runSmoke({ baseUrl, startedAt, budgetMs, restart }) {
  const createClient = () =>
    new AgentClient({
      baseUrl: `${baseUrl}/v1/agent`,
      client: { name: 'blade-web-starter-smoke', version: '2.0.0' },
      headers: { authorization: 'Bearer local-demo' },
    });
  const controller = new AbortController();
  const { signal } = controller;
  const deadline = setTimeout(
    () => controller.abort(new Error('Two-minute Web smoke budget exceeded')),
    Math.max(1, budgetMs - (performance.now() - startedAt)),
  );
  let client = createClient();
  let session;
  let cursor = null;
  const toolNames = [];
  const approvals = [];

  const collect = async (requestId, onStream) => {
    let output = '';
    for await (const event of session.events({ after: cursor, signal })) {
      if (cursor && event.sequence <= cursor.sequence) {
        throw new Error('Event replay duplicated an already consumed event');
      }
      cursor = {
        protocolVersion: event.protocolVersion,
        sessionId: event.sessionId,
        sequence: event.sequence,
        eventId: event.eventId,
      };
      if (event.type === 'session.closed') throw new Error('Session closed before producing a result');
      if (event.type === 'permission.requested') {
        // Without an OS sandbox, Bash needs approval. The smoke approves for the session.
        approvals.push(event.data.toolName);
        await client.resolvePermission(
          session.sessionId,
          event.data.permissionRequestId,
          { approved: true, scope: 'session' },
          { signal },
        );
        continue;
      }
      if (event.type !== 'session.stream' || event.requestId !== requestId) continue;
      const data = event.data;
      if (data.type === 'tool_use') toolNames.push(data.name);
      if (data.type === 'content') output += data.delta;
      if (data.type === 'error') throw new Error(data.message);
      await onStream?.(data);
      if (data.type === 'result') {
        if (data.subtype !== 'success') throw new Error(`Request failed: ${data.error ?? 'unknown error'}`);
        return output || data.content || '';
      }
    }
    signal.throwIfAborted();
    throw new Error('Session event stream ended before producing a result');
  };

  try {
    session = await client.createSession({ source: 'web-starter-smoke' }, { signal });
    const sessionId = session.sessionId;

    // Steps 5-8: the task runs Glob, Read and Bash; steering right after Bash starts
    // interrupts the script, which then runs Grep and reports with a security section.
    const first = await session.send(TASK, { signal });
    if (first.status !== 'started' || !first.requestId) {
      throw new Error(`Unexpected submission: ${JSON.stringify(first)}`);
    }
    let steer;
    const report = await collect(first.requestId, async (data) => {
      if (!steer && data.type === 'tool_use' && data.name === 'Bash') {
        steer = await session.send(STEER, { priority: 'now', signal });
        if (steer.status !== 'steered') {
          throw new Error(`Steering was not accepted: ${JSON.stringify(steer)}`);
        }
      }
    });
    const firstResultMs = Math.round((performance.now() - startedAt) * 100) / 100;
    for (const name of ['Glob', 'Read', 'Bash', 'Grep']) {
      if (!toolNames.includes(name)) {
        throw new Error(`Expected a ${name} tool call; saw ${toolNames.join(', ') || 'none'}`);
      }
    }
    if (!steer) throw new Error('The script never reached Bash, so steering was not exercised');
    if (!report.includes(REPORT_TITLE) || !report.includes(SECURITY_SECTION)) {
      throw new Error(`Report did not reflect steering:\n${report}`);
    }

    // Step 9: restart the server process' runtime, resume the same session, keep going.
    const before = await session.read({ signal });
    if (!hasReport(before.messages)) throw new Error('Report missing from history before restart');
    const messagesBefore = before.messages.length;

    await restart();
    client = createClient();
    session = await client.resumeSession(sessionId, { signal });
    const after = await session.read({ signal });
    if (!hasReport(after.messages) || after.messages.length !== messagesBefore) {
      throw new Error(
        `History was not restored after restart: ${messagesBefore} messages before, ${after.messages?.length ?? 0} after`,
      );
    }

    const continued = await session.send(CONTINUE, { signal });
    if (continued.status !== 'started' || !continued.requestId) {
      throw new Error(`Unexpected continuation submission: ${JSON.stringify(continued)}`);
    }
    const continuation = await collect(continued.requestId);
    if (!continuation.includes(CONTINUATION_PREFIX)) {
      throw new Error(`Continuation did not use the saved report:\n${continuation}`);
    }
    await session.close({ signal });
    session = undefined;
    return {
      firstResultMs,
      toolNames,
      steered: true,
      approvals,
      restoredMessages: messagesBefore,
      continuationRestored: true,
      report,
    };
  } finally {
    clearTimeout(deadline);
    controller.abort();
    await session?.close({ signal: AbortSignal.timeout(5_000) }).catch(() => undefined);
  }
}
```

- [ ] **Step 2: 重写 `server.mjs`**

用下面的内容整体替换 `examples/web-agent-server/server.mjs`（三个锚点 `const webRoot = root;`、`const projectRoot = root;` 保持原样，脚手架会替换它们）：

```js
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import open from 'open';
import { getSandboxExecutor, JsonlSessionRepository } from '@blade-ai/agent-sdk/advanced';
import { AgentServer, JsonlAgentServerStore } from '@blade-ai/agent-sdk/server/infra';
import {
  createDemoProviderRegistry,
  DEMO_MODEL,
  DEMO_PROVIDER_TYPE,
  NPM_CACHE_FLAG,
} from './DemoProvider.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const webRoot = root;
const projectRoot = root;
const generated = join(projectRoot, '.generated');
const startedAt = performance.now();
const SMOKE_BUDGET_MS = 2 * 60 * 1_000;
const READ_ONLY_RULES = ['Read', 'Read:*', 'Glob', 'Glob:*', 'Grep', 'Grep:*'];

function parseArgs(argv) {
  const options = {
    smoke: false,
    open: true,
    port: Number(process.env.PORT || 8787),
    root: process.cwd(),
    dataDir: join(projectRoot, '.blade'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      return next;
    };
    if (argument === '--smoke') options.smoke = true;
    else if (argument === '--no-open') options.open = false;
    else if (argument === '--port') options.port = Number(value());
    else if (argument === '--root') options.root = resolve(value());
    else if (argument === '--data-dir') options.dataDir = resolve(value());
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function loadEnvFile() {
  const envPath = join(projectRoot, '.env');
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  return envPath;
}

async function askForApiKey() {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(
      'Paste an OpenAI-compatible API key to use a real model, or press Enter to run the built-in scripted demo: ',
    );
    return answer.trim();
  } finally {
    readline.close();
  }
}

async function saveApiKey(envPath, apiKey) {
  const existing = existsSync(envPath) ? await readFile(envPath, 'utf8') : '';
  const separator = existing && !existing.endsWith('\n') ? '\n' : '';
  await writeFile(envPath, `${existing}${separator}OPENAI_API_KEY=${apiKey}\n`);
}

async function resolveModel({ smoke, analysisRoot, envPath }) {
  const scripted = () => ({
    provider: { type: DEMO_PROVIDER_TYPE },
    providerRegistry: createDemoProviderRegistry({ root: analysisRoot, smoke }),
    model: DEMO_MODEL,
    label: 'built-in scripted demo (no API key)',
  });
  if (smoke) return scripted();
  let apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey && process.stdin.isTTY && process.stdout.isTTY) {
    apiKey = await askForApiKey();
    if (apiKey) {
      await saveApiKey(envPath, apiKey);
      process.stdout.write(`Saved OPENAI_API_KEY to ${envPath}\n`);
    }
  }
  if (!apiKey) {
    process.stdout.write(
      'No API key configured: running the built-in scripted demo. Set OPENAI_API_KEY, and optionally OPENAI_BASE_URL and OPENAI_MODEL, to use a real model.\n',
    );
    return scripted();
  }
  const baseUrl = process.env.OPENAI_BASE_URL;
  const model = process.env.OPENAI_MODEL || 'gpt-5-mini';
  return {
    provider: baseUrl ? { type: 'openai-compatible', apiKey, baseUrl } : { type: 'openai', apiKey },
    providerRegistry: undefined,
    model,
    label: `${model} via ${baseUrl || 'OpenAI'}`,
  };
}

/** Run one command through the SDK's own sandbox wrapper; only a passing probe enables it. */
function probeSandbox(workDir) {
  const executor = getSandboxExecutor();
  const settings = { enabled: true };
  if (!executor.canUseSandbox(settings)) {
    return { enabled: false, reason: 'no supported sandbox runtime on this platform' };
  }
  try {
    const wrapped = executor.wrapCommand(
      'echo blade-sandbox-ok',
      executor.buildExecutionOptions(workDir),
      settings,
    );
    const run = spawnSync('bash', ['-c', wrapped], { encoding: 'utf8', timeout: 15_000 });
    if (run.status === 0 && run.stdout.includes('blade-sandbox-ok')) {
      return { enabled: true, reason: 'probe passed' };
    }
    const firstLine = (run.stderr || `probe exited ${run.status ?? run.signal}`).trim().split('\n')[0];
    return { enabled: false, reason: firstLine };
  } catch (error) {
    return { enabled: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function systemPrompt(analysisRoot, sandbox) {
  return [
    'You are a repository analysis assistant running inside the Blade web starter.',
    `The workspace root is ${analysisRoot}. Use Glob, Grep and Read to inspect files, and Bash for read-only commands such as npm ls, npm audit and cat.`,
    `Always add ${NPM_CACHE_FLAG} to npm commands so caches stay out of the home directory.`,
    sandbox.enabled
      ? 'Shell commands run inside an OS sandbox that confines writes to the workspace.'
      : 'Shell commands are not sandboxed here; each one is shown to the user for approval before it runs.',
    'Never modify files. Report risks with evidence: file paths, versions and the exact commands you ran.',
    'When the user changes focus mid-task, acknowledge it and adjust the remaining steps.',
  ].join(' ');
}

async function createRuntime({ analysisRoot, dataDir, model, sandbox }) {
  await mkdir(join(dataDir, 'sessions'), { recursive: true });
  const store = new JsonlAgentServerStore({ directory: join(dataDir, 'server') });
  await store.initialize();
  const repository = new JsonlSessionRepository(join(dataDir, 'sessions'), 100, analysisRoot);
  await repository.initialize();
  const agent = new AgentServer({
    store,
    authenticate(request) {
      if (request.headers.get('authorization') !== 'Bearer local-demo') return null;
      return { tenantId: 'local-demo', subject: 'browser-user', scopes: ['session:admin'] };
    },
    resolveSessionOptions() {
      return {
        provider: model.provider,
        providerRegistry: model.providerRegistry,
        model: model.model,
        allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
        permissionMode: sandbox.enabled ? 'yolo' : 'default',
        permissions: { allow: sandbox.enabled ? [...READ_ONLY_RULES, 'Bash', 'Bash:*'] : READ_ONLY_RULES },
        sandbox: { enabled: sandbox.enabled },
        defaultContext: { capabilities: { filesystem: { roots: [analysisRoot], cwd: analysisRoot } } },
        sessionRepository: repository,
        sessionEventStore: repository,
        systemPrompt: systemPrompt(analysisRoot, sandbox),
        maxTurns: 24,
      };
    },
  });
  return {
    agent,
    async close() {
      await agent.close();
      await store.close();
    },
  };
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length === 0 ? undefined : Buffer.concat(chunks);
}

const options = parseArgs(process.argv.slice(2));
const envPath = loadEnvFile();
let fixture;
if (options.smoke) {
  const { createSmokeFixture } = await import('./smoke.mjs');
  fixture = await createSmokeFixture();
  options.root = fixture.root;
  options.dataDir = fixture.dataDir;
  options.open = false;
}

await mkdir(generated, { recursive: true });
await build({
  entryPoints: [join(webRoot, 'client.js')],
  outfile: join(generated, 'client.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  conditions: ['browser'],
});

const model = await resolveModel({ smoke: options.smoke, analysisRoot: options.root, envPath });
const sandbox = probeSandbox(options.root);
const runtimeOptions = { analysisRoot: options.root, dataDir: options.dataDir, model, sandbox };
let runtime = await createRuntime(runtimeOptions);

const server = createServer(async (request, response) => {
  const connectionController = new AbortController();
  const onDisconnect = () => {
    if (!response.writableFinished) connectionController.abort(new Error('HTTP client disconnected'));
  };
  request.once('aborted', onDisconnect);
  response.once('close', onDisconnect);
  try {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(await readFile(join(webRoot, 'index.html')));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/client.js') {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(await readFile(join(generated, 'client.js')));
      return;
    }
    const body = await requestBody(request);
    const upstream = await runtime.agent.handle(
      new Request(`http://127.0.0.1${request.url || '/'}`, {
        method: request.method,
        headers: request.headers,
        signal: connectionController.signal,
        ...(body ? { body } : {}),
      }),
    );
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    if (!upstream.body) {
      response.end();
      return;
    }
    // pipeline destroys the source when the browser closes the SSE connection.
    await pipeline(Readable.fromWeb(upstream.body), response);
  } catch (error) {
    if (connectionController.signal.aborted || response.destroyed) return;
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  } finally {
    request.removeListener('aborted', onDisconnect);
    response.removeListener('close', onDisconnect);
  }
});

function listen(port) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolvePromise();
    });
  });
}

function closeServer() {
  return new Promise((resolvePromise, reject) => {
    if (!server.listening) {
      resolvePromise();
      return;
    }
    server.close((error) => (error ? reject(error) : resolvePromise()));
    server.closeAllConnections();
  });
}

let shutdownStarted = false;
async function shutdown() {
  if (shutdownStarted) return;
  shutdownStarted = true;
  await closeServer();
  await runtime.close();
}

for (const signalName of ['SIGINT', 'SIGTERM']) {
  process.once(signalName, () => {
    void shutdown().then(
      () => process.exit(0),
      (error) => {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        process.exit(1);
      },
    );
  });
}

await listen(options.smoke ? 0 : options.port);
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Web Agent example did not expose a TCP address');
const baseUrl = `http://127.0.0.1:${address.port}`;

if (options.smoke) {
  const { runSmoke } = await import('./smoke.mjs');
  try {
    const summary = await runSmoke({
      baseUrl,
      startedAt,
      budgetMs: SMOKE_BUDGET_MS,
      restart: async () => {
        await runtime.close();
        runtime = await createRuntime(runtimeOptions);
      },
    });
    process.stdout.write(`${JSON.stringify({ ...summary, sandbox }, null, 2)}\n`);
  } finally {
    await shutdown();
    await fixture?.cleanup();
  }
} else {
  process.stdout.write(
    [
      `Blade web starter: ${baseUrl}`,
      `  workspace : ${options.root}`,
      `  data      : ${options.dataDir}`,
      `  model     : ${model.label}`,
      `  sandbox   : ${sandbox.enabled ? 'on' : `off (${sandbox.reason}); Bash asks for approval`}`,
      '',
    ].join('\n'),
  );
  if (options.open && process.stdout.isTTY) {
    await open(baseUrl).catch(() => undefined);
  }
}
```

- [ ] **Step 3: 构建并跑 smoke**

Run: `pnpm build && node examples/web-agent-server/server.mjs --smoke`
Expected: 两分钟内输出 JSON，含 `"toolNames": ["Glob", "Read", "Bash", "Grep", ...]`（顺序可能因为 steering 中断略有差异，但四个名字都在）、`"steered": true`、`"continuationRestored": true`，`report` 里有 `Focus adjusted: security`。macOS 上修复了 Task 2 之后 `sandbox.enabled` 应为 `true` 且 `approvals` 为空；Linux CI 上没有 bubblewrap 时 `approvals` 会含 `Bash`。

如果 smoke 卡在第一个 Bash 上，先确认 `permissions.allow` 与 `permissionMode` 两个分支和 Global Constraints 里写的事实一致。

- [ ] **Step 4: 手工起一次服务看输出**

Run: `node examples/web-agent-server/server.mjs --no-open`
Expected: 打印 `Blade web starter: http://127.0.0.1:8787`、workspace、data、model、sandbox 五行，`.blade/server/server-store.jsonl` 与 `.blade/sessions/` 被创建；Ctrl+C 正常退出。旧界面此时仍能发消息（Task 7 才换界面）。

- [ ] **Step 5: 提交**

```bash
git add examples/web-agent-server/server.mjs examples/web-agent-server/smoke.mjs
git commit -m "feat(examples): web starter runs real tools, persists sessions and passes a nine-step smoke"
```

---

### Task 7: 时间线界面与 steering（`index.html`、`client.js`）

**Files:**
- Modify: `examples/web-agent-server/index.html`（整体替换）
- Modify: `examples/web-agent-server/client.js`（整体替换）

**Interfaces:**
- Consumes: `AgentClient` / `RemoteAgentSession`（`createSession`、`resumeSession`、`readSession`、`send({ priority })`、`events({ after })`、`abort`、`close`、`resolvePermission(sessionId, permissionRequestId, { approved, scope }, { commandId, signal })`）；SSE 事件 `session.stream`（内含 `thinking`、`content`、`tool_use`、`tool_progress`、`tool_result`、`input_applied`、`turn_interrupted`、`result`、`error`）、`permission.requested`、`session.closed`。
- Produces: 无 API。production preset 通过 `examples/production-stack/run.mjs` 打包同一个 `client.js` 并使用同一个 `index.html`，因此审批卡片必须保留 `expected_content` / `content` 的 Before/After 展示。

- [ ] **Step 1: 替换 `index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Blade Agent</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f6f7f9; --panel: #ffffff; --ink: #1c1f26; --muted: #66707f; --line: #e2e6ec;
      --accent: #2f6df6; --accent-ink: #ffffff; --ok: #1f9d55; --warn: #d97706; --bad: #dc2626; --chip: #eef2ff;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #0f1216; --panel: #171b21; --ink: #e6e9ee; --muted: #8b95a5; --line: #2a313b; --accent: #6b9dff; --accent-ink: #0b1220; --chip: #1e2740; }
    }
    * { box-sizing: border-box; }
    body { margin: 0; font: 15px/1.5 var(--sans); color: var(--ink); background: var(--bg); height: 100vh; display: flex; flex-direction: column; }
    header.bar { display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid var(--line); background: var(--panel); }
    header .brand { font-weight: 650; }
    header .session { font: 12px var(--mono); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 34ch; }
    header .spacer { flex: 1; }
    .pill { font-size: 12px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
    .pill[data-tone="work"] { border-color: var(--accent); color: var(--accent); }
    .pill[data-tone="wait"] { border-color: var(--warn); color: var(--warn); }
    .pill[data-tone="bad"] { border-color: var(--bad); color: var(--bad); }
    .pill[data-tone="ok"] { border-color: var(--ok); color: var(--ok); }
    button { font: inherit; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); padding: 6px 12px; cursor: pointer; }
    button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
    button:disabled { opacity: .5; cursor: default; }
    #notice { margin: 0; padding: 4px 20px; color: var(--warn); font-size: 13px; min-height: 24px; }
    #timeline { flex: 1; overflow-y: auto; padding: 8px 20px 24px; display: flex; flex-direction: column; gap: 10px; max-width: 920px; width: 100%; margin: 0 auto; }
    .node { border-radius: 12px; padding: 10px 14px; background: var(--panel); border: 1px solid var(--line); }
    .node.user { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); align-self: flex-end; max-width: 80%; white-space: pre-wrap; }
    .node.assistant { white-space: pre-wrap; }
    .node.system, .node.steer { align-self: center; font-size: 13px; color: var(--muted); background: transparent; border-style: dashed; }
    .node.steer { color: var(--accent); border-color: var(--accent); background: var(--chip); border-style: solid; }
    .node.error { border-color: var(--bad); color: var(--bad); white-space: pre-wrap; }
    details.node > summary { cursor: pointer; font-size: 13px; color: var(--muted); }
    .node pre { margin: 8px 0 0; font: 12px/1.45 var(--mono); white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto; color: var(--muted); }
    .node.tool .head { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .node.tool .name { font: 600 13px var(--mono); }
    .node.tool .args { font: 12px var(--mono); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .node.tool .meta { font-size: 12px; color: var(--muted); }
    .node.tool[data-status="Running"] .name::before { content: "●"; color: var(--accent); margin-right: 6px; animation: pulse 1s infinite; }
    .node.tool[data-status="Completed"] .name::before { content: "✓"; color: var(--ok); margin-right: 6px; }
    .node.tool[data-status="Failed"] .name::before, .node.tool[data-status="Ended"] .name::before, .node.tool[data-status="Cancelled"] .name::before { content: "✕"; color: var(--bad); margin-right: 6px; }
    .node.tool details summary { font-size: 12px; color: var(--muted); cursor: pointer; margin-top: 6px; }
    @keyframes pulse { 50% { opacity: .3; } }
    .approval { border-color: var(--warn); }
    .approval h3 { margin: 0 0 4px; font-size: 15px; }
    .approval p { margin: 4px 0; }
    .approval .actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
    form { display: flex; gap: 10px; padding: 12px 20px 6px; border-top: 1px solid var(--line); background: var(--panel); }
    form .inner { display: flex; gap: 10px; max-width: 920px; width: 100%; margin: 0 auto; }
    textarea { flex: 1; min-height: 44px; max-height: 160px; resize: vertical; font: inherit; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); }
    textarea[data-steering="true"] { border-color: var(--accent); box-shadow: 0 0 0 2px var(--chip); }
    .hint { margin: 0; padding: 0 20px 12px; font-size: 12px; color: var(--muted); background: var(--panel); text-align: center; }
    @media (max-width: 640px) { header .session { display: none; } .node.user { max-width: 100%; } }
  </style>
</head>
<body>
  <header class="bar">
    <span class="brand">Blade Agent</span>
    <span class="session" id="session-id" title="Session id">Not started</span>
    <span class="spacer"></span>
    <span class="pill" id="status" role="status" data-tone="">Starting</span>
    <button id="reconnect" type="button" hidden>Reconnect</button>
    <button id="new-session" type="button">New session</button>
  </header>
  <p id="notice" role="alert"></p>
  <section id="timeline" aria-live="polite"></section>
  <form id="prompt-form">
    <div class="inner">
      <textarea
        id="prompt"
        name="prompt"
        rows="2"
        placeholder="Ask the agent to analyze this project's dependency risks"
        aria-label="Prompt"
      ></textarea>
      <button id="submit" type="submit" class="primary">Send</button>
      <button id="cancel" type="button" disabled>Cancel</button>
    </div>
  </form>
  <p class="hint" id="hint">Enter sends, Shift+Enter adds a line.</p>
  <script type="module" src="/client.js"></script>
</body>
</html>
```

- [ ] **Step 2: 替换 `client.js`**

```js
import { AgentClient } from '@blade-ai/agent-sdk/browser';

const query = (selector) => document.querySelector(selector);
const form = query('#prompt-form');
const promptInput = query('#prompt');
const timeline = query('#timeline');
const status = query('#status');
const notice = query('#notice');
const hint = query('#hint');
const sessionLabel = query('#session-id');
const submit = query('#submit');
const cancel = query('#cancel');
const reconnect = query('#reconnect');
const newSession = query('#new-session');

if (!form || !promptInput || !timeline || !status || !notice || !hint || !sessionLabel
  || !submit || !cancel || !reconnect || !newSession) {
  throw new Error('Web Agent starter markup is incomplete');
}

const client = new AgentClient({
  baseUrl: `${window.location.origin}/v1/agent`,
  client: { name: 'blade-web-starter', version: '2.0.0' },
  headers: { authorization: 'Bearer local-demo' },
});
const STORAGE_KEY = 'blade-web-session:v2';
const MAX_NODES = 200;
const OUTPUT_PREVIEW_LINES = 20;
const DEFAULT_PLACEHOLDER = "Ask the agent to analyze this project's dependency risks";
const emptyState = () => ({
  version: 2,
  sessionId: null,
  createCommandId: null,
  cursor: null,
  nodes: [],
  activeRequestId: null,
  pendingSubmission: null,
  cancelCommandId: null,
  pendingTerminal: null,
  permissions: [],
  handledPermissionIds: [],
  retiredPermissionIds: [],
  lastStatus: 'Idle',
});

let state = emptyState();
let session;
let generation = 0;
let operationController;
let streamController;
let connecting = false;
let disconnected = false;
let unavailable = false;
let storageWarning = '';

// ---------- persistence ----------

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    storageWarning = 'This browser could not save the conversation; refresh recovery is unavailable.';
  }
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!saved) return;
    const optional = (value) => value === null || typeof value === 'string';
    if (saved.version !== 2 || !optional(saved.sessionId) || !optional(saved.activeRequestId)
      || !optional(saved.cancelCommandId) || !Array.isArray(saved.nodes)
      || !Array.isArray(saved.permissions) || !Array.isArray(saved.handledPermissionIds)
      || !Array.isArray(saved.retiredPermissionIds)
      || !saved.nodes.every((node) => node && typeof node.id === 'string' && typeof node.kind === 'string')) {
      throw new Error('Invalid saved conversation');
    }
    state = { ...emptyState(), ...saved };
  } catch {
    state = emptyState();
    storageWarning = 'The saved conversation could not be restored. Send a message to start again.';
  }
}

// ---------- timeline model ----------

function addNode(node) {
  const created = { id: crypto.randomUUID(), ...node };
  state.nodes.push(created);
  if (state.nodes.length > MAX_NODES) state.nodes.splice(0, state.nodes.length - MAX_NODES);
  return created;
}

function lastNode(predicate) {
  return state.nodes.findLast(predicate);
}

function findTool(toolId) {
  return lastNode((node) => node.kind === 'tool' && node.toolId === toolId);
}

function hasRequest() {
  return Boolean(state.activeRequestId || state.pendingSubmission);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((part) => part && part.type === 'text').map((part) => part.text).join('');
  }
  return '';
}

function summarizeArgs(input) {
  try {
    const text = typeof input === 'string' ? input : JSON.stringify(input ?? {});
    return text.length > 160 ? `${text.slice(0, 157)}…` : text;
  } catch {
    return '';
  }
}

function previewOutput(output) {
  let text;
  if (output && typeof output === 'object' && !Array.isArray(output) && 'stdout' in output) {
    text = [output.stdout, output.stderr].filter(Boolean).join('\n');
  } else {
    text = typeof output === 'string' ? output : JSON.stringify(output ?? '', null, 2);
  }
  return text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
}

function applyStreamEvent(data) {
  const requestId = state.activeRequestId;
  switch (data.type) {
    case 'thinking': {
      let node = lastNode((entry) => entry.requestId === requestId);
      if (!node || node.kind !== 'thinking') node = addNode({ kind: 'thinking', requestId, text: '', open: false });
      node.text += data.delta;
      return;
    }
    case 'content': {
      let node = lastNode((entry) => entry.requestId === requestId);
      if (!node || node.kind !== 'assistant') node = addNode({ kind: 'assistant', requestId, text: '' });
      node.text += data.delta;
      return;
    }
    case 'tool_use':
      addNode({
        kind: 'tool',
        requestId,
        toolId: data.id,
        name: data.name,
        args: summarizeArgs(data.input),
        status: 'Running',
        summary: '',
        output: '',
        startedAt: Date.now(),
        endedAt: null,
        open: false,
      });
      return;
    case 'tool_progress': {
      const node = findTool(data.id);
      if (!node) return;
      const { message, completed, total } = data.progress ?? {};
      const progress = Number.isFinite(completed) && Number.isFinite(total) ? `${completed}/${total}` : '';
      node.summary = [message, progress].filter(Boolean).join(' · ').slice(0, 300);
      return;
    }
    case 'tool_result': {
      const node = findTool(data.id);
      if (!node) return;
      node.status = data.isError ? 'Failed' : 'Completed';
      node.endedAt = Date.now();
      node.summary = (data.display?.summary ?? '').slice(0, 300);
      node.output = previewOutput(data.output);
      return;
    }
    case 'input_applied': {
      const steer = lastNode((entry) => entry.kind === 'steer' && entry.inputId === data.inputId);
      if (steer) steer.status = 'applied';
      return;
    }
    case 'turn_interrupted':
      addNode({ kind: 'system', requestId, text: 'Interrupting the current step to apply your instruction' });
      return;
    case 'result':
      if (data.subtype === 'success' && data.content
        && !lastNode((entry) => entry.requestId === requestId && entry.kind === 'assistant')) {
        addNode({ kind: 'assistant', requestId, text: data.content });
      }
      state.pendingTerminal = { status: data.subtype === 'success' ? 'Idle' : 'Failed', message: data.error ?? '' };
      return;
    case 'error':
      addNode({ kind: 'error', requestId, text: data.message });
      state.pendingTerminal = { status: 'Failed', message: data.message };
      return;
    default:
      return;
  }
}

// ---------- rendering ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function duration(node) {
  if (!node.startedAt) return '';
  const ms = (node.endedAt ?? Date.now()) - node.startedAt;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const STEER_LABELS = {
  pending: 'Steering…',
  steered: 'Steered',
  queued: 'Queued for next turn',
  applied: 'Steering applied',
  started: 'Sent as a new turn',
  failed: 'Steering rejected',
};

function renderTool(node) {
  const article = el('article', 'node tool');
  article.dataset.status = node.status;
  const head = el('div', 'head');
  head.append(
    el('span', 'name', node.name),
    el('span', 'args', node.args),
    el('span', 'meta', [node.status, duration(node)].filter(Boolean).join(' · ')),
  );
  article.append(head);
  if (node.summary) article.append(el('div', 'meta', node.summary));
  if (node.output) {
    const lines = node.output.split('\n');
    const details = el('details');
    details.open = Boolean(node.open);
    details.append(
      el('summary', '', `Output (${lines.length} lines)`),
      el('pre', '', lines.slice(0, node.open ? lines.length : OUTPUT_PREVIEW_LINES).join('\n')),
    );
    details.addEventListener('toggle', () => {
      node.open = details.open;
      save();
      render();
    });
    article.append(details);
  }
  return article;
}

function renderNode(node) {
  switch (node.kind) {
    case 'user':
      return el('article', 'node user', node.text);
    case 'assistant':
      return el('article', 'node assistant', node.text);
    case 'system':
      return el('article', 'node system', node.text);
    case 'error':
      return el('article', 'node error', node.text);
    case 'steer':
      return el('article', 'node steer', `${STEER_LABELS[node.status] ?? node.status}: ${node.text}`);
    case 'thinking': {
      const details = el('details', 'node thinking');
      details.open = Boolean(node.open);
      details.append(el('summary', '', 'Thinking'), el('pre', '', node.text));
      details.addEventListener('toggle', () => {
        node.open = details.open;
        save();
      });
      return details;
    }
    case 'tool':
      return renderTool(node);
    default:
      return el('article', 'node system', node.text ?? '');
  }
}

function renderApproval(permission) {
  const article = el('article', 'node approval');
  article.append(
    el('h3', '', permission.title || `Allow ${permission.toolName}?`),
    el('p', 'meta', permission.toolName),
    el('p', '', permission.message || 'This action needs your approval.'),
  );
  for (const [label, values] of [['Affected paths', permission.affectedPaths], ['Risks', permission.risks]]) {
    if (Array.isArray(values) && values.length) article.append(el('p', 'meta', `${label}: ${values.join(', ')}`));
  }
  if (permission.input && Object.keys(permission.input).length) {
    const replacement = typeof permission.input.expected_content === 'string'
      && typeof permission.input.content === 'string';
    const details = el('details');
    details.open = replacement;
    details.append(el('summary', '', replacement ? 'Proposed file change' : 'Tool input'));
    for (const [label, text] of replacement
      ? [['Before', permission.input.expected_content], ['After', permission.input.content]]
      : [['', JSON.stringify(permission.input, null, 2)]]) {
      if (label) details.append(el('p', 'meta', label));
      details.append(el('pre', '', text));
    }
    article.append(details);
  }
  const actions = el('div', 'actions');
  for (const [label, approved, scope] of [
    ['Approve once', true, 'once'],
    ['Approve for this session', true, 'session'],
    ['Deny', false, 'once'],
  ]) {
    const button = el('button', approved ? 'primary' : '', label);
    button.type = 'button';
    button.setAttribute('aria-label', `${label}: ${permission.toolName}`);
    button.disabled = Boolean(permission.decision || state.cancelCommandId)
      || connecting || disconnected || unavailable || !navigator.onLine;
    button.addEventListener('click', () => {
      if (!button.disabled) void decidePermission(permission.permissionRequestId, approved, scope);
    });
    actions.append(button);
  }
  article.append(actions);
  if (permission.decision) article.append(el('p', 'meta', 'Confirming your decision…'));
  return article;
}

function toneFor(label, waiting) {
  if (waiting) return 'wait';
  if (label === 'Working' || label === 'Cancelling' || label === 'Reconnecting' || label === 'Starting') return 'work';
  if (['Failed', 'Disconnected', 'Unavailable', 'Offline'].includes(label)) return 'bad';
  if (label === 'Idle' || label === 'Restored') return 'ok';
  return '';
}

function render(label = state.lastStatus, message = '') {
  const waiting = label === 'Working' && state.permissions.length > 0;
  status.textContent = waiting ? 'Waiting for approval' : label;
  status.dataset.tone = toneFor(label, waiting);
  notice.textContent = message || storageWarning;
  sessionLabel.textContent = state.sessionId ?? 'Not started';
  const offline = !navigator.onLine;
  const blocked = connecting || unavailable || disconnected || offline;
  const steering = hasRequest() && !blocked;
  promptInput.disabled = blocked;
  submit.disabled = blocked;
  promptInput.dataset.steering = String(steering);
  promptInput.placeholder = steering ? 'Agent is working, type to steer it' : DEFAULT_PLACEHOLDER;
  submit.textContent = steering ? 'Steer' : 'Send';
  hint.textContent = steering
    ? 'Enter inserts your instruction into the running task right away.'
    : 'Enter sends, Shift+Enter adds a line.';
  cancel.disabled = connecting || !state.activeRequestId || Boolean(state.cancelCommandId)
    || disconnected || unavailable || offline;
  reconnect.hidden = !disconnected || unavailable;
  reconnect.disabled = connecting || offline;
  newSession.disabled = connecting || (hasRequest() && !unavailable);
  const stick = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
  timeline.replaceChildren(...state.nodes.map(renderNode), ...state.permissions.map(renderApproval));
  if (stick) timeline.scrollTop = timeline.scrollHeight;
}

// ---------- request lifecycle ----------

function clearPermissions() {
  for (const permission of state.permissions) {
    if (!state.retiredPermissionIds.includes(permission.permissionRequestId)) {
      state.retiredPermissionIds.push(permission.permissionRequestId);
    }
  }
  state.permissions = [];
}

function stopConnection() {
  generation += 1;
  operationController?.abort();
  streamController?.abort();
  connecting = false;
}

function finishRequest(label, message = '') {
  streamController?.abort();
  state.activeRequestId = null;
  state.pendingSubmission = null;
  state.cancelCommandId = null;
  state.pendingTerminal = null;
  clearPermissions();
  for (const node of state.nodes) {
    if (node.kind === 'tool' && node.status === 'Running') {
      node.status = label === 'Cancelled' ? 'Cancelled' : 'Ended';
      node.endedAt = Date.now();
      node.summary ||= 'No tool result was received for this attempt.';
    }
    if (node.kind === 'steer' && node.status === 'pending') node.status = 'failed';
  }
  state.lastStatus = label === 'Cancelled' || label === 'Idle' ? 'Idle' : label;
  disconnected = false;
  save();
  render(label, message);
}

function failed(error) {
  const code = error?.protocolCode;
  if (['SESSION_NOT_FOUND', 'SESSION_CLOSED', 'STALE_CURSOR'].includes(code)) {
    clearPermissions();
    save();
    unavailable = true;
    disconnected = false;
    render('Unavailable', code === 'STALE_CURSOR'
      ? 'This conversation can no longer be replayed. The saved timeline is kept; start a new session to continue.'
      : 'This session is no longer available on the server. The saved timeline is kept; start a new session to continue.');
    return;
  }
  disconnected = true;
  render('Disconnected', `${error instanceof Error ? error.message : String(error)}. Reconnect to continue the same request.`);
}

function isDefiniteRejection(error) {
  return Boolean(error?.protocolCode)
    && !['COMMAND_IN_PROGRESS', 'INTERNAL_ERROR'].includes(error.protocolCode);
}

async function readEvents(currentGeneration) {
  const controller = new AbortController();
  streamController = controller;
  try {
    for await (const event of session.events({ after: state.cursor, signal: controller.signal })) {
      if (currentGeneration !== generation || controller.signal.aborted) return;
      if (event.sessionId !== state.sessionId) continue;
      if (event.sequence <= (state.cursor?.sequence ?? 0)) continue;
      state.cursor = {
        protocolVersion: event.protocolVersion,
        sessionId: event.sessionId,
        sequence: event.sequence,
        eventId: event.eventId,
      };
      if (event.type === 'session.closed') {
        save();
        failed({ protocolCode: 'SESSION_CLOSED' });
        return;
      }
      if (event.type === 'permission.requested') {
        const id = event.data.permissionRequestId;
        if (state.activeRequestId && (!event.requestId || event.requestId === state.activeRequestId)
          && !state.handledPermissionIds.includes(id) && !state.retiredPermissionIds.includes(id)
          && !state.permissions.some((permission) => permission.permissionRequestId === id)) {
          state.permissions.push({
            permissionRequestId: id,
            toolName: event.data.toolName,
            title: event.data.title,
            message: event.data.message,
            input: event.data.input,
            affectedPaths: event.data.affectedPaths,
            risks: event.data.risks,
            requestId: state.activeRequestId,
            decision: null,
          });
        }
        save();
        render(state.cancelCommandId ? 'Cancelling' : 'Working');
        continue;
      }
      if (event.type !== 'session.stream' || event.requestId !== state.activeRequestId) {
        save();
        continue;
      }
      applyStreamEvent(event.data);
      if (state.pendingTerminal) clearPermissions();
      if (state.pendingTerminal && !state.cancelCommandId) {
        finishRequest(state.pendingTerminal.status, state.pendingTerminal.message);
        return;
      }
      save();
      render(state.cancelCommandId ? 'Cancelling' : 'Working');
    }
    if (!controller.signal.aborted && currentGeneration === generation && hasRequest()) {
      throw new Error('The connection ended before the request completed');
    }
  } catch (error) {
    if (!controller.signal.aborted && currentGeneration === generation) failed(error);
  }
}

async function confirmPermission(permission, currentGeneration, signal) {
  if (!state.permissions.includes(permission) || !permission.decision) return;
  try {
    await client.resolvePermission(state.sessionId, permission.permissionRequestId, {
      approved: permission.decision.approved,
      scope: permission.decision.scope,
    }, { commandId: permission.decision.commandId, signal });
  } catch (error) {
    if (currentGeneration !== generation || !state.permissions.includes(permission)) return;
    if (!isDefiniteRejection(error)
      || ['SESSION_NOT_FOUND', 'SESSION_CLOSED'].includes(error.protocolCode)) throw error;
    permission.decision = null;
    if (error.protocolCode === 'PERMISSION_NOT_FOUND') {
      state.permissions = state.permissions.filter((entry) => entry !== permission);
    }
    save();
    render(state.cancelCommandId ? 'Cancelling' : 'Working', error.protocolCode === 'PERMISSION_NOT_FOUND'
      ? 'This approval expired or was already resolved. Waiting for the agent to continue.'
      : `Your decision was not accepted: ${error.message}`);
    return;
  }
  if (currentGeneration !== generation || !state.permissions.includes(permission)) return;
  state.handledPermissionIds.push(permission.permissionRequestId);
  state.permissions = state.permissions.filter((entry) => entry !== permission);
  save();
  render(state.cancelCommandId ? 'Cancelling' : 'Working');
}

async function decidePermission(id, approved, scope) {
  const permission = state.permissions.find((entry) => entry.permissionRequestId === id);
  if (!permission || permission.decision || state.cancelCommandId || disconnected || unavailable) return;
  permission.decision = { approved, scope, commandId: crypto.randomUUID() };
  save();
  render('Working');
  const currentGeneration = generation;
  try {
    await confirmPermission(permission, currentGeneration, operationController?.signal);
  } catch (error) {
    if (currentGeneration === generation) failed(error);
  }
}

async function confirmCancellation(currentGeneration, signal) {
  try {
    await session.abort({ commandId: state.cancelCommandId, signal });
  } catch (error) {
    if (currentGeneration !== generation) return;
    if (!isDefiniteRejection(error)) throw error;
    state.cancelCommandId = null;
    const message = `Cancellation was not accepted: ${error.message}`;
    if (state.pendingTerminal) {
      finishRequest(state.pendingTerminal.status, message);
    } else {
      streamController?.abort();
      disconnected = false;
      save();
      render('Working', message);
      void readEvents(currentGeneration);
    }
    return;
  }
  if (currentGeneration !== generation) return;
  finishRequest('Cancelled');
}

async function hydrateFromServer(signal) {
  const snapshot = await client.readSession(state.sessionId, { signal });
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  if (state.nodes.length === 0) {
    const tools = new Map();
    for (const message of messages) {
      const text = textOf(message.content);
      if (message.role === 'user' && text) addNode({ kind: 'user', text });
      if (message.role === 'assistant') {
        for (const call of message.tool_calls ?? []) {
          const node = addNode({
            kind: 'tool',
            toolId: call.id,
            name: call.function?.name ?? 'tool',
            args: summarizeArgs(call.function?.arguments ?? ''),
            status: 'Completed',
            summary: '',
            output: '',
            startedAt: null,
            endedAt: null,
            open: false,
          });
          tools.set(call.id, node);
        }
        if (text) addNode({ kind: 'assistant', text });
      }
      if (message.role === 'tool') {
        const node = tools.get(message.tool_call_id);
        if (node) node.output = previewOutput(text);
      }
    }
  }
  addNode({ kind: 'system', text: `Restored from disk, ${messages.length} messages` });
  state.lastStatus = 'Idle';
}

async function connect() {
  stopConnection();
  const currentGeneration = generation;
  const controller = new AbortController();
  operationController = controller;
  connecting = true;
  disconnected = false;
  unavailable = false;
  render(state.sessionId ? 'Reconnecting' : 'Starting');
  try {
    if (!session) {
      if (state.sessionId) {
        let resumed;
        try {
          resumed = await client.resumeSession(state.sessionId, { signal: controller.signal });
        } catch (error) {
          if (error?.protocolCode === 'SESSION_CONFLICT') {
            const snapshot = await client.readSession(state.sessionId, { signal: controller.signal });
            if (snapshot.session?.status === 'closed') {
              if (currentGeneration !== generation) return;
              connecting = false;
              failed({ protocolCode: 'SESSION_CLOSED' });
              return;
            }
          }
          throw error;
        }
        if (currentGeneration !== generation) return;
        session = resumed;
        await hydrateFromServer(controller.signal);
        if (currentGeneration !== generation) return;
        save();
      } else if (state.pendingSubmission) {
        state.createCommandId ??= crypto.randomUUID();
        save();
        const created = await client.createSession({ source: 'web-starter' }, {
          commandId: state.createCommandId,
          signal: controller.signal,
        });
        if (currentGeneration !== generation) return;
        session = created;
        state.sessionId = session.sessionId;
        state.createCommandId = null;
        save();
      }
    }
    if (currentGeneration !== generation) return;
    if (state.pendingSubmission) {
      const submission = await session.send(state.pendingSubmission.input, {
        commandId: state.pendingSubmission.commandId,
        signal: controller.signal,
      });
      if (currentGeneration !== generation) return;
      if (!submission.requestId) throw new Error('The server did not identify the submitted request');
      state.activeRequestId = submission.requestId;
      state.pendingSubmission = null;
      state.lastStatus = 'Working';
      save();
    }
    connecting = false;
    if (state.cancelCommandId) {
      render('Cancelling');
      await confirmCancellation(currentGeneration, controller.signal);
    } else if (state.activeRequestId) {
      render('Working');
      void readEvents(currentGeneration);
      for (const permission of [...state.permissions]) {
        if (currentGeneration !== generation) return;
        if (permission.decision) await confirmPermission(permission, currentGeneration, controller.signal);
      }
    } else {
      render(state.lastStatus);
    }
  } catch (error) {
    if (currentGeneration !== generation) return;
    connecting = false;
    if (state.pendingSubmission && isDefiniteRejection(error)
      && !['SESSION_NOT_FOUND', 'SESSION_CLOSED', 'STALE_CURSOR'].includes(error.protocolCode)) {
      promptInput.value = state.pendingSubmission.input;
      state.createCommandId = null;
      finishRequest('Failed', `Message was not accepted: ${error.message}`);
      return;
    }
    failed(error);
  }
}

async function steer(input) {
  const node = addNode({ kind: 'steer', text: input, status: 'pending', inputId: null });
  save();
  render('Working');
  const currentGeneration = generation;
  try {
    const submission = await session.send(input, {
      priority: 'now',
      commandId: crypto.randomUUID(),
      signal: operationController?.signal,
    });
    if (currentGeneration !== generation) return;
    node.status = submission.status;
    node.inputId = submission.inputId ?? null;
    if (submission.status === 'started' && submission.requestId) {
      // The previous request finished just before this arrived; it became a new turn.
      state.activeRequestId = submission.requestId;
      if (!streamController || streamController.signal.aborted) void readEvents(currentGeneration);
    }
  } catch (error) {
    if (currentGeneration !== generation) return;
    node.status = 'failed';
    node.text = `${input} (${error instanceof Error ? error.message : String(error)})`;
  }
  save();
  render(state.cancelCommandId ? 'Cancelling' : hasRequest() ? 'Working' : state.lastStatus);
}

// ---------- wiring ----------

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = promptInput.value.trim();
  if (!input || submit.disabled) return;
  promptInput.value = '';
  if (hasRequest()) {
    void steer(input);
    return;
  }
  addNode({ kind: 'user', text: input });
  state.pendingSubmission = { commandId: crypto.randomUUID(), input };
  state.pendingTerminal = null;
  save();
  void connect();
});

promptInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

cancel.addEventListener('click', async () => {
  if (cancel.disabled) return;
  state.cancelCommandId = crypto.randomUUID();
  save();
  render('Cancelling');
  const currentGeneration = generation;
  try {
    await confirmCancellation(currentGeneration, operationController?.signal);
  } catch (error) {
    if (currentGeneration === generation) failed(error);
  }
});

reconnect.addEventListener('click', () => { void connect(); });

newSession.addEventListener('click', async () => {
  if (newSession.disabled) return;
  stopConnection();
  const previous = session;
  session = undefined;
  state = emptyState();
  unavailable = false;
  disconnected = false;
  save();
  render();
  promptInput.focus();
  await previous?.close({ signal: AbortSignal.timeout(5000) }).catch(() => undefined);
});

window.addEventListener('offline', () => {
  stopConnection();
  disconnected = true;
  render('Offline', 'Waiting for a connection. Your current request is saved.');
});
window.addEventListener('online', () => { void connect(); });
window.addEventListener('pagehide', () => { save(); stopConnection(); });
window.addEventListener('pageshow', (event) => {
  if (event.persisted) void connect();
});

restore();
render();
if (state.sessionId || state.pendingSubmission) void connect();
```

- [ ] **Step 3: 构建、跑 smoke、手工走 9 步**

Run: `pnpm build && node examples/web-agent-server/server.mjs --smoke`
Expected: 仍然通过（smoke 不依赖 DOM，但 esbuild 会打包新的 `client.js`，语法错误会在这里暴露）。

再手工验证（无 key，脚本化 provider）：

```bash
node examples/web-agent-server/server.mjs
```

浏览器里依次确认：输入 `Analyze this project's dependency risks` 后出现 Thinking 折叠块、Glob/Read/Bash 三张工具卡（状态从 Running 变 Completed，带耗时和可展开输出）、最终报告流式出现；在 Bash 卡出现时输入 `Focus on security issues` 回车，出现 `Steered:` 卡片，随后 `Steering applied`，Grep 卡片，报告含 `Focus adjusted: security`；Ctrl+C 停服务再 `node examples/web-agent-server/server.mjs`，刷新页面出现 `Restored from disk, N messages`，输入 `Continue the analysis` 得到 `Continuing from the saved analysis`。

再验证 production 的 smoke 没有被界面改动影响（需要 Docker 与 PostgreSQL 容器）：`pnpm example:production -- --smoke`；没有 Docker 的机器上记录为“未在本机执行，交给 CI”。

- [ ] **Step 4: 提交**

```bash
git add examples/web-agent-server/index.html examples/web-agent-server/client.js
git commit -m "feat(examples): timeline UI with mid-run steering and restore notes"
```

---

### Task 8: 脚手架、验证脚本、README 与文档

**Files:**
- Modify: `package.json`（`files` 列表）
- Modify: `src/cli/createBladeAgent.ts`（`PackageManifest`、`commandFor`、`copyWebTemplate`、`dependencies`、`webReadme`、`.gitignore`，新增 `startBladeAgent`）
- Modify: `src/cli/create-blade-agent.ts`（`--no-start`）
- Modify: `src/cli/__tests__/createBladeAgent.test.ts`（web 用例）
- Modify: `scripts/verify-create-blade-agent.mjs`（web contract）
- Modify: `examples/README.md`、`docs/golden-paths.md`、`docs/en/golden-paths.md`、`README.md`、`README.zh-CN.md`
- Create: `.changes/web-preset-first-run.json`

**Interfaces:**
- Consumes: Task 6 的锚点 `const webRoot = root;`、`const projectRoot = root;`，smoke 输出里的 `"continuationRestored": true`。
- Produces: `create-blade-agent --preset web` 生成 `src/server.mjs`、`src/DemoProvider.mjs`、`src/smoke.mjs`、`web/index.html`、`web/client.js`、`.env.example`、`.gitignore`（含 `.blade/`）、`README.md`、`package.json`（依赖 `@blade-ai/agent-sdk`、`esbuild`、`open`）；交互终端下安装完成即启动；`--no-start` 关闭。

- [ ] **Step 1: 更新脚手架测试（先失败）**

在 `src/cli/__tests__/createBladeAgent.test.ts` 的用例 `generates a browser and in-process server project without PostgreSQL` 中，把依赖断言与 server 断言改为：

```ts
      dependencies: {
        '@blade-ai/agent-sdk': 'file:/tmp/blade-agent-sdk.tgz',
        esbuild: '0.28.2',
        open: '^11.0.0',
      },
```

```ts
    const server = await readFile(join(result.directory, 'src/server.mjs'), 'utf8');
    expect(server).toContain("const webRoot = join(root, '../web');");
    expect(server).toContain("const projectRoot = join(root, '..');");
    expect(server).not.toContain('const projectRoot = root;');
    expect(server).toContain('JsonlAgentServerStore');
    for (const file of ['src/DemoProvider.mjs', 'src/smoke.mjs', '.env.example']) {
      await readFile(join(result.directory, file));
    }
    expect(await readFile(join(result.directory, '.gitignore'), 'utf8')).toContain('.blade/');
    expect(await readFile(join(result.directory, 'web/client.js'), 'utf8')).toContain(
      '@blade-ai/agent-sdk/browser',
    );
```

删除该用例里原来的 `expect(server).toContain("const generated = join(root, '../.generated');");` 一行。

Run: `pnpm vitest run src/cli/__tests__/createBladeAgent.test.ts`
Expected: web 用例失败（缺 `open`、缺新文件、锚点不同）。

- [ ] **Step 2: 修改 `createBladeAgent.ts`**

`PackageManifest` 增加 `dependencies`：

```ts
interface PackageManifest {
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}
```

`commandFor` 的第二个参数改为 `script?: 'smoke' | 'start'`（函数体不变）。在 `getBladeAgentSdkVersion` 之后新增：

```ts
export async function startBladeAgent(
  project: Pick<CreateBladeAgentResult, 'directory' | 'packageManager'>,
): Promise<void> {
  const [command, args] = commandFor(project.packageManager, 'start');
  await runProcess(command, args, { cwd: project.directory });
}
```

`copyWebTemplate` 整体替换为：

```ts
async function copyWebTemplate(sourceRoot: string, directory: string): Promise<void> {
  for (const file of [
    ['web-agent-server/index.html', 'web/index.html'],
    ['web-agent-server/client.js', 'web/client.js'],
    ['web-agent-server/DemoProvider.mjs', 'src/DemoProvider.mjs'],
    ['web-agent-server/smoke.mjs', 'src/smoke.mjs'],
  ] as const) {
    await copyFile(sourceRoot, directory, file[0], file[1]);
  }
  const serverSource = await readFile(join(sourceRoot, 'web-agent-server/server.mjs'), 'utf8');
  for (const marker of ['const webRoot = root;', 'const projectRoot = root;']) {
    if (!serverSource.includes(marker)) {
      throw new Error(`Web template marker is missing: ${marker}`);
    }
  }
  const server = serverSource
    .replace('const webRoot = root;', "const webRoot = join(root, '../web');")
    .replace('const projectRoot = root;', "const projectRoot = join(root, '..');");
  await writeFile(join(directory, 'src/server.mjs'), server);
  await writeFile(
    join(directory, '.env.example'),
    'OPENAI_API_KEY=\nOPENAI_MODEL=gpt-5-mini\nOPENAI_BASE_URL=\n',
  );
}
```

`dependencies()` 改为：

```ts
function dependencies(
  preset: CreateBladeAgentPreset,
  manifest: PackageManifest,
  sdkSpecifier: string,
): Readonly<Record<string, string>> {
  return {
    '@blade-ai/agent-sdk': sdkSpecifier,
    ...(preset === 'web' || preset === 'production'
      ? { esbuild: readDependency(manifest.devDependencies, 'esbuild') }
      : {}),
    ...(preset === 'web' ? { open: readDependency(manifest.dependencies, 'open') } : {}),
    ...(preset === 'production' ? { pg: readDependency(manifest.peerDependencies, 'pg') } : {}),
  };
}
```

`.gitignore` 写入改为：

```ts
  await writeFile(
    join(directory, '.gitignore'),
    'node_modules/\n.blade/\n.data/\n.generated/\n.env\n*.log\n',
  );
```

`webReadme` 整体替换为：

```ts
function webReadme(name: string, run: string): string {
  return `# ${name}

Generated by \`create-blade-agent --preset web\`. Requires Node.js 22.14 or later.

## First run

\`\`\`bash
${run} start
\`\`\`

The server asks once for an OpenAI-compatible API key (press Enter to run the
built-in scripted demo instead), saves it to \`.env\`, and opens the browser.
Then:

1. Ask: **Analyze this project's dependency risks**. Watch the Agent think, run
   Glob, Read and Bash, and stream a report.
2. While it is working, type **Focus on security issues** and press Enter. The
   instruction is inserted with priority \`now\`; the Agent adjusts course.
3. Stop the server with Ctrl+C, run \`${run} start\` again, refresh the page and
   ask **Continue the analysis**. The session, its history and event cursor
   come back from disk.

## Configuration

| Setting | Meaning |
|---|---|
| \`OPENAI_API_KEY\` | Enables a real model. Without it the scripted demo runs the same tools. |
| \`OPENAI_BASE_URL\` | Any OpenAI-compatible endpoint (DeepSeek, Qwen, GLM, local servers). |
| \`OPENAI_MODEL\` | Model id, default \`gpt-5-mini\`. |
| \`--root <dir>\` | Analyze another repository: \`${run} start -- --root ../my-app\`. |
| \`--data-dir <dir>\` | Where sessions live, default \`.blade/\`. |
| \`--no-open\` | Do not open the browser. |

Tools: Read, Glob, Grep and Bash, scoped to the workspace root. When an OS
sandbox is available (macOS seatbelt, Linux bubblewrap) Bash runs inside it and
is auto-approved; otherwise every command appears as an approval card in the
browser. Destructive commands always ask.

Persistence: \`.blade/server/server-store.jsonl\` (session records, event log,
approvals) and \`.blade/sessions/\` (transcripts). Delete \`.blade/\` to start
clean.

## Acceptance check

\`\`\`bash
${run} smoke
\`\`\`

Runs the nine steps above non-interactively with the scripted demo in under two
minutes: tools, mid-run steering, a simulated restart and a continued session.

The request traverses:

\`\`\`text
Browser AgentClient
→ AgentServer (JsonlAgentServerStore)
→ in-process Session (JsonlSessionRepository)
→ SSE
\`\`\`

This scaffold is for local development. Replace the demo authentication
callback before exposing it on a network.
`;
}
```

- [ ] **Step 3: 修改 CLI 入口**

`src/cli/create-blade-agent.ts`：

导入改为：

```ts
import {
  type CreateBladeAgentOptions,
  type CreateBladeAgentPackageManager,
  type CreateBladeAgentPreset,
  createBladeAgent,
  getBladeAgentSdkVersion,
  startBladeAgent,
} from './createBladeAgent.js';
```

`HELP` 在 `--verify` 一行之后加：

```
  --no-start                            Do not start the web server after installation
```

`ParsedArguments` 增加 `readonly start: boolean;`。在 `parseCreateBladeAgentArgs` 里声明 `let start = true;`，在 `--verify` 分支后加：

```ts
    if (argument === '--no-start') {
      start = false;
      continue;
    }
```

返回值加 `start`。`runCreateBladeAgentCli` 末尾（写完 `Created ...` 之后）加：

```ts
  const shouldStart =
    parsed.start &&
    result.preset === 'web' &&
    result.installed &&
    !result.verified &&
    Boolean(process.stdout.isTTY);
  if (shouldStart) {
    process.stdout.write('Starting the web server (Ctrl+C to stop)…\n');
    await startBladeAgent(result);
  }
```

- [ ] **Step 4: `package.json` 的 `files` 列表**

在 `"examples/web-agent-server/index.html",` 之后加两行（保持字母顺序即可）：

```json
    "examples/web-agent-server/DemoProvider.mjs",
    "examples/web-agent-server/smoke.mjs",
```

不要加 `DemoProvider.test.mjs`。

- [ ] **Step 5: 验证脚本的 web contract**

`scripts/verify-create-blade-agent.mjs` 里 `web:` 改为：

```js
  web: {
    budgetMs: 2 * 60 * 1_000,
    expectedOutput: '"continuationRestored": true',
    files: [
      'README.md',
      '.env.example',
      'src/server.mjs',
      'src/DemoProvider.mjs',
      'src/smoke.mjs',
      'web/index.html',
      'web/client.js',
    ],
    dependencies: ['@blade-ai/agent-sdk', 'esbuild', 'open'],
  },
```

- [ ] **Step 6: 运行脚手架测试与 lint**

Run: `pnpm vitest run src/cli/__tests__/createBladeAgent.test.ts && pnpm lint:fix && pnpm lint && pnpm type-check`
Expected: 全部通过。

- [ ] **Step 7: 文档**

`examples/README.md` 的 `## Web + AgentServer` 一节整体替换为：

```markdown
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
```

`docs/golden-paths.md` 的 `## Web + AgentServer` 一节整体替换为：

```markdown
## Web + AgentServer

```bash
pnpm example:web
```

打开 <http://127.0.0.1:8787>。浏览器使用 `AgentClient`，服务端使用 `AgentServer`，
状态落在 `.blade/` 下：`JsonlAgentServerStore` 保存会话记录、事件日志和审批，
`JsonlSessionRepository` 保存转录。未设置 `OPENAI_API_KEY` 时由脚本化 provider
驱动同一套真实工具；设置后调用真实模型，`OPENAI_BASE_URL` 可指向任何兼容端点。

页面是一条时间线：思考、带状态和输出的工具卡、审批卡、插入指令的标记和流式回答。
输入 **Analyze this project's dependency risks**，运行中再输入 **Focus on security
issues** 回车，指令以 `now` 优先级插入当前任务。停掉服务再启动、刷新页面后输入
**Continue the analysis**，会话记录、事件游标和转录都从磁盘恢复。`--root <dir>`
分析别的仓库，`--no-open` 不打开浏览器。

工具是 Read、Glob、Grep 和 Bash。OS 沙箱可用时（macOS seatbelt、Linux bubblewrap）
Bash 在沙箱内运行并自动放行；否则每条命令都是一张审批卡。破坏性命令始终询问。

`node examples/web-agent-server/server.mjs --smoke` 用脚本化 provider 走完 9 步：
工具、steering、在同一数据目录上重建 store 与 server 的模拟重启、续写会话。
```

`docs/en/golden-paths.md` 的 `## Web + AgentServer` 一节替换为 `examples/README.md` 里的同名英文内容（去掉第一行标题后的空行差异即可）。

`README.md` 的 “Generate a Browser + AgentServer application:” 段落改为：

```markdown
Generate a Browser + AgentServer application (real tools, mid-run steering, and
sessions that survive a restart under `.blade/`):

```bash
npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --preset web
```

In a terminal the server starts and opens the browser as soon as the install
finishes; add `--no-start` to skip that, or `--verify` to run the nine-step
smoke instead.
```

`README.zh-CN.md` 对应段落改为：

```markdown
生成 Browser + AgentServer 应用（真实工具、运行中插入指令、重启后会话仍在 `.blade/`）：

```bash
npm exec --yes --package=@blade-ai/agent-sdk@latest -- \
  create-blade-agent my-agent --preset web
```

在终端里，安装完成后服务会直接启动并打开浏览器；加 `--no-start` 跳过，
或加 `--verify` 改为运行 9 步 smoke。
```

- [ ] **Step 8: fragment、docs 构建、提交**

创建 `.changes/web-preset-first-run.json`：

```json
{
  "type": "feature",
  "en": "create-blade-agent --preset web now scaffolds a first-run experience: real Read/Glob/Grep/Bash tools, a timeline UI with mid-run steering and approval cards, sessions that survive a server restart, a scripted no-key demo, and a nine-step smoke.",
  "zh-CN": "create-blade-agent --preset web 现在生成完整的首跑体验：真实的 Read/Glob/Grep/Bash 工具、带运行中插入指令与审批卡片的时间线界面、重启后仍在的会话、无 key 的脚本化 demo，以及 9 步 smoke。"
}
```

```bash
pnpm docs:build && pnpm changelog:check
git add package.json src/cli/createBladeAgent.ts src/cli/create-blade-agent.ts src/cli/__tests__/createBladeAgent.test.ts scripts/verify-create-blade-agent.mjs examples/README.md docs/golden-paths.md docs/en/golden-paths.md README.md README.zh-CN.md .changes/web-preset-first-run.json
git commit -m "feat(cli): web preset ships the first-run experience and starts itself"
```

---

### Task 9: 全量门禁与 macOS 手工验证

**Files:** 无新文件；只运行与修复。

- [ ] **Step 1: 全量门禁**

按顺序运行，任何一步失败就修到通过再继续：

```bash
pnpm lint
pnpm type-check
pnpm test
pnpm build
node --test examples/web-agent-server/DemoProvider.test.mjs
node examples/web-agent-server/server.mjs --smoke
pnpm verify:entrypoints
pnpm docs:build
pnpm changelog:check
pnpm verify:install
pnpm verify:create-agent
```

Expected：全部为 0 退出码。`verify:create-agent` 会 `npm pack` 后在临时目录安装并对三个 preset 各跑一次 `--verify`；production 步骤需要 Docker，本机没有 Docker 时记录“production 步骤未在本机执行，交给 CI”，不要跳过其它步骤。

- [ ] **Step 2: macOS 真 key 手工走 9 步**

```bash
cd /tmp && rm -rf demo && npx --yes --package=/Users/bytedance/Documents/GitHub/blade-agent-sdk create-blade-agent demo --preset web
```

（本地开发时也可以先 `npm pack` 再用 `--sdk-version file:<tarball>`。）

确认：终端问 key，填入后浏览器打开；`Analyze this project's dependency risks` 出现 Thinking、Glob/Read/Bash 工具卡与报告；沙箱状态行显示 `on`，Bash 没有弹审批卡；运行中输入 `Focus on security issues` 出现 Steered 与 Grep；Ctrl+C 后 `npm start`，刷新出现 `Restored from disk`，`Continue the analysis` 得到延续回答。再用 `--no-open` 启动一次并在 `server.mjs` 的 `probeSandbox` 返回值临时改为 `{ enabled: false }` 验证审批卡片路径，验证完还原。

- [ ] **Step 3: 收尾**

- `git status` 干净，所有提交都在 `feat/web-preset-first-run`。
- 在 PR 描述里列出：四个 changelog fragment、smoke 输出 JSON、macOS 手工验证记录、未在本机执行的步骤。
