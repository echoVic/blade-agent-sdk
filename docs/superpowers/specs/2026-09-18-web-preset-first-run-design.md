# Web preset 首跑体验设计（9 步流程）

- 日期：2026-09-18
- 状态：待评审
- 范围：`create-blade-agent --preset web` 生成的项目、`examples/web-agent-server` 模板、SDK 新增 `JsonlAgentServerStore`

## 1. 目标

让 `npx create-blade-agent demo --preset web` 在 5 分钟内走完下面 9 步。除一个 API key 之外不需要任何配置；没有 key 时也能用脚本化 provider 看到完整流程。

1. 创建项目
2. 安装依赖
3. 启动服务
4. 浏览器自动打开，显示聊天界面
5. 用户输入 `Analyze this project's dependency risks`
6. 界面实时显示思考、工具调用、中间结果、最终报告
7. 执行过程中用户直接在输入框输入 `Focus on security issues` 并回车
8. Agent 立即响应，调整方向
9. 关掉服务再启动，页面恢复历史，输入 `Continue the analysis`，会话续上

成功标准：

- 9 步由 `npm run smoke` 和 `pnpm verify:create-agent` 用脚本化 provider 自动覆盖。
- macOS 上用真实 key 手工走通，Bash 在沙箱内自动放行，`npm audit` 可用。
- 现有 production preset 的 smoke 继续通过（它与 web preset 共用 `client.js`）。

## 2. 现状与差距

| 步骤 | 现状 |
|---|---|
| 1 到 2 | 已有 |
| 3 | 脚手架结束后要手动运行 `npm start` |
| 4 | 不自动打开浏览器；界面只有一个状态标签和消息列表 |
| 5 | 会话配置 `allowedTools: []`，没有任何工具；无 key 时的 provider 只回声 `AgentServer received: <输入>` |
| 6 | `client.js` 已有工具活动列表和审批卡片的渲染代码，但 web preset 没有工具所以触发不到；没有思考过程展示 |
| 7 到 8 | 请求进行中输入框被禁用，只剩取消。SDK 的 steering（`session.send` 带 `priority: 'now'`）、协议字段和浏览器客户端 `submitInput({ priority })` 都已存在，只缺界面 |
| 9 | `AgentServer` 默认 `InMemoryAgentServerStore`，重启即丢。SDK 只有内存和 PostgreSQL 两种 store。会话转录可以用 `/advanced` 导出的 `JsonlSessionRepository` 落盘，但 server 自己的会话记录、SSE 事件日志、幂等键和命令租约没有文件实现 |

## 3. 范围

做：

- SDK：`InMemoryAgentServerStore` 增加日志钩子与恢复入口；新增 `JsonlAgentServerStore`，从 `@blade-ai/agent-sdk/server/infra` 导出。
- 示例模板：`examples/web-agent-server/` 下的 `server.mjs`、`client.js`、`index.html`，新增 `DemoProvider.mjs`。
- 脚手架：`src/cli/createBladeAgent.ts` 的 web preset（依赖、模板文件、README、自动启动）。
- 验证：`server.mjs --smoke` 覆盖 9 步；`scripts/verify-create-blade-agent.mjs` 的 web 期望同步。
- 文档：`docs/server-runtime.md` 与 `docs/en/server-runtime.md`（新 store）、`docs/golden-paths.md` 与 `docs/en/golden-paths.md`、`examples/README.md`、`README.md` 与 `README.zh-CN.md` 里 web preset 的段落。
- changelog fragment：两条 feature，一条是新 store，一条是 web preset 首跑体验。

不做：

- 多语言界面、Windows 沙箱、Edit 与 Write 工具、多进程文件锁、任何协议改动、production preset 的服务端改动。
- 运行期压缩日志文件（只在启动时压缩）。
- 每次写入 fsync。进程崩溃不丢已确认的写入；断电可能丢最后几行。

## 4. SDK 设计：文件 store

### 4.1 `InMemoryAgentServerStore` 的日志钩子

新增类型与选项：

```ts
export interface CommandLeaseSnapshot {
  readonly leaseId: ExecutionLeaseId;
  readonly commandFingerprint: string;
  readonly expiresAt: number;
  readonly sealed: boolean;
  readonly result?: AgentCommandResult;
  readonly abandonReason?: string;
}

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

export interface InMemoryAgentServerStoreOptions {
  maxEventsPerSession?: number;
  now?: () => number;
  journal?: AgentServerStoreJournal;
}
```

写入规则：

- 每个改动状态的方法在更新内存之后、返回之前 `await journal.append(entry)`。`putSession` 写 `session`；`appendEvent` 真正追加了事件时写 `event`（幂等重复调用不写）；`claimCommand`、`sealCommand`、`completeCommand`、`abandonCommand` 写 `lease`，内容是该命令的整份租约状态；`releaseCommand` 写 `lease` 且 `lease` 为 `null`。
- `event` 条目里的 `event` 带 store 自己生成的 `eventId` 和 `sequence`。租约 id 也是 store 内部用 nanoid 生成的，所以日志必须由 store 自己写，外层封装拿不到这些 id。
- 日志写入失败：方法以该错误 reject，store 进入 failed 状态，`healthCheck()` 返回 `ready: false`，后续所有改动方法直接以 `RuntimeStoreError` reject。读方法照常。这样内存领先磁盘的状态不会被继续扩大。

恢复入口：

```ts
restore(entries: Iterable<AgentServerStoreJournalEntry>): void;
snapshot(): AgentServerStoreJournalEntry[];
```

- `restore` 按顺序应用条目且不写日志。`session` 写入 sessions；`event` 走一条不生成 id 的内部追加路径，与 `appendEvent` 共用同一个 `appendToLog(log, event)`，因此保留窗口（`maxEventsPerSession`）、`firstSequence`、`nextSequence` 和 `waitForEvents` 的唤醒规则与内存版一致；`event` 带幂等键时同时登记幂等表；`event_key` 只登记幂等表，不进事件日志；`lease` 为对象则 set，为 `null` 则 delete。
- `restore` 只允许在 store 尚无任何状态时调用，否则抛错。
- `snapshot` 输出当前全部状态：所有 session 记录；每个事件日志里仍保留的事件，按 sequence 升序，带各自的幂等键；已被保留窗口裁掉但幂等表里仍持有的事件，输出为 `event_key`；所有租约，包括已过期的，恢复后仍按 `expiresAt` 判定。`restore(snapshot())` 得到的状态与原状态等价，包括 `readEvents` 可见范围、`getEventStreamRange`、`getEventByIdempotencyKey` 和租约的 sealed 与过期语义。

### 4.2 `JsonlAgentServerStore`

```ts
export interface JsonlAgentServerStoreOptions {
  readonly directory: string;
  readonly maxEventsPerSession?: number;
  readonly now?: () => number;
}

export class JsonlAgentServerStore implements AgentServerStore {
  constructor(options: JsonlAgentServerStoreOptions);
  initialize(): Promise<void>;
  close(): Promise<void>;
  // AgentServerStore 的 11 个方法（含可选方法）全部委托给内部 InMemoryAgentServerStore
}
```

- 文件：`<directory>/server-store.jsonl`，一行一个 JSON 对象，形如 `{"v":1,"kind":"event",...}`。`v` 不等于 1 拒绝启动。
- `initialize()`：建目录；若文件存在则逐行解析并 `restore`；然后用 `snapshot()` 通过 `write-file-atomic` 重写文件完成压缩；最后以追加模式打开一个文件句柄。未调用 `initialize()` 就使用任何方法抛错。
- 追加：一个串行写队列，每条 `await handle.write(line + '\n')` 完成后 `append` 才 resolve，因此 store 方法 resolve 时该行已交给操作系统。
- 解析容错：只有最后一行、且文件不以换行结尾、且该行解析失败时，视为进程崩溃留下的截断行，跳过并通过 SDK logger 告警；其他任何解析失败或 `kind` 未知，抛 `RuntimeStoreError`，错误码 `RUNTIME_STORE_CORRUPT_JOURNAL`，消息带文件路径和行号。
- `close()`：等待写队列排空后关闭句柄。关闭后的改动方法 reject。
- `healthCheck()`：`{ ready, details: { directory } }`，`ready` 为内部 store 的 ready 且句柄打开。
- 定位：单进程单机。多实例部署继续使用 PostgreSQL store。文档明确说明这一点，不做文件锁。

### 4.3 对外与文档

- `src/server/runtime.ts` 导出 `JsonlAgentServerStore`、`JsonlAgentServerStoreOptions`、`AgentServerStoreJournal`、`AgentServerStoreJournalEntry`、`CommandLeaseSnapshot`；`src/browser/server-only-stub.ts` 同步加 `JsonlAgentServerStore` 的 stub，保持 `verify:entrypoints` 通过。
- `RuntimeStoreErrorCode` 新增 `RUNTIME_STORE_CORRUPT_JOURNAL`。
- `docs/server-runtime.md` 与 `docs/en/server-runtime.md` 增加“单进程文件 store”一节：适用场景、目录布局、损坏时的处理（删除 `.blade/server` 从头开始，`.blade/sessions` 里的转录会成为孤儿，不影响新会话）。
- `.changes/jsonl-agent-server-store.json`，类型 feature。

## 5. 示例与脚手架设计

`examples/web-agent-server/` 是 web preset 的模板源，脚手架把 `server.mjs`、`web/index.html`、`web/client.js` 拷进生成的项目。改模板即改 preset。production preset 通过 `examples/production-stack/run.mjs` 打包同一个 `client.js`，界面改动两边同时受益。

### 5.1 `server.mjs`

启动流程：

1. 解析参数：`--smoke`、`--port <n>`（已有）、`--root <dir>`（分析目录，默认 `process.cwd()`，即生成的项目目录）、`--data-dir <dir>`（持久化目录，默认 `<process.cwd()>/.blade`）、`--no-open`。
2. 若 `.env` 存在，`process.loadEnvFile('.env')`。
3. 模型配置：
   - 有 `OPENAI_API_KEY`：有 `OPENAI_BASE_URL` 时用 openai-compatible provider（`baseUrl` 加 `apiKey`），否则用 openai provider；模型为 `OPENAI_MODEL`，默认 `gpt-5-mini`。
   - 无 key、非 smoke、`process.stdin.isTTY`：用 `node:readline` 提示一次 `Paste an OpenAI-compatible API key to use a real model, or press Enter to run the built-in scripted demo:`。非空则追加 `OPENAI_API_KEY=<值>` 到 `.env` 并按上一条使用；空则用脚本化 provider。
   - 其他情况用脚本化 provider，并打印一行说明如何设置 key。
4. 持久化：在数据目录下创建 `server/` 与 `sessions/`；`store = new JsonlAgentServerStore({ directory: '<data-dir>/server' })` 并 `initialize()`；会话转录用 `JsonlSessionRepository` 指向 `<data-dir>/sessions/`，同时作为 `sessionRepository` 与 `sessionEventStore` 传入会话选项。
5. `AgentServer` 配置：`authenticate` 沿用 bearer `local-demo`；`store` 为上面的文件 store；`resolveSessionOptions` 返回：
   - provider、model、providerRegistry（脚本化时）；
   - `allowedTools: ['Read', 'Glob', 'Grep', 'Bash']`；
   - `defaultContext.capabilities.filesystem = { roots: [root], cwd: root }`；
   - `sandbox`：启用，`autoAllowBashIfSandboxed: true`，网络白名单只含 `registry.npmjs.org`，让 `npm audit` 可用；沙箱不可用时不改任何配置，SDK 现有逻辑会让 Bash 走审批，审批以 `permission.requested` 事件到达浏览器；
   - `sessionRepository` 与 `sessionEventStore`；
   - `systemPrompt`：仓库分析助手。说明工作区根目录、可用工具、只读原则（不修改文件）、报告要带证据（文件路径、版本、执行过的命令）。
6. 静态资源与 esbuild 打包 `client.js` 保持现状。
7. 监听成功后打印 URL；非 smoke、未指定 `--no-open`、`process.stdout.isTTY` 时用 `open` 打开浏览器；打开失败只打印 URL。

### 5.2 `DemoProvider.mjs`

仿 `examples/production-stack/RepositoryDemoProvider.mjs`，实现 `chat` 与 `streamChat`，通过 `providerRegistry` 注册，provider 类型名 `web-starter-demo`。它是无状态的，每次调用根据 `messages` 判断处于剧本的哪一步。判断顺序固定：先看历史里是否已有最终报告（续写分支），再看最初任务之后是否出现了新的用户消息（steering 分支），最后按已有的工具结果推进剧本：

| 条件 | 动作 |
|---|---|
| 没有任何工具结果 | 先输出一段 thinking（`Locating manifests and lockfiles`），然后调用 Glob，模式 `package.json` 与 `{package-lock.json,pnpm-lock.yaml,yarn.lock,bun.lock}` |
| 有 Glob 结果、无 Read 结果 | Read `package.json` |
| 有 Read 结果、无 Bash 结果 | Bash `npm ls --depth=0 --json`（离线可用；非零退出码也当数据处理） |
| 最初任务之后又出现了新的用户消息（steering） | 下一步改为 Grep，模式 `postinstall|preinstall|eval\(|child_process`，范围 `package.json` 与 `src/`，最终报告增加 `Focus adjusted: security` 一节 |
| 以上工具结果齐全 | 输出最终报告（见下） |
| 历史里已有一份最终报告，且新的用户消息是继续类请求 | 不调用工具，输出 `Continuing from the saved analysis (<N> dependencies reviewed).` 加两条后续建议，其中 N 取自历史报告，证明历史已恢复 |

最终报告用真实工具输出生成：直接依赖数、使用 `^`、`~`、`*`、`latest` 等未锁定范围的依赖列表、是否存在锁文件、`engines` 是否声明、`npm ls` 报告的缺失或无效依赖。找不到 `package.json` 时报告 `No Node manifest found under <root>` 并列出顶层文件。工具失败时在报告里如实写明命令与错误。

节奏：交互模式下每步之间延迟 300 到 800 毫秒，smoke 下 20 毫秒，与现有实现的 `smoke ? 20 : 120` 同一机制。

### 5.3 界面：`client.js` 与 `index.html`

结构：

- 顶栏：会话 id、状态标签、`New session` 按钮。状态取值：`Starting`、`Idle`、`Working`、`Waiting for approval`、`Reconnecting`、`Disconnected`、`Restored`（短暂显示后回到 `Idle`）、`Unavailable`。
- 主体：按 `requestId` 分组的时间线。节点类型与来源：
  - 用户输入：本地提交时插入。
  - 思考：`session.stream` 内的 `thinking` 事件，默认折叠，流式追加。
  - 工具卡：`tool_use` 创建（工具名、参数摘要），`tool_progress` 更新状态与消息，`tool_result` 标记完成或失败，显示耗时与输出预览（前 20 行，可展开）。
  - 审批卡：`permission.requested`，沿用现有实现与 `resolvePermission` 调用，保留“本次”与“整个会话”两种批准范围。
  - 插入指令 chip：`submitInput` 返回 `steered` 时插入 `Steered: <文本>`；返回 `queued` 时插入 `Queued for next turn: <文本>`。
  - 系统提示：恢复后插入 `Restored from disk, <N> messages`；断线重连、取消等沿用现有文案。
  - 最终回答：`content` 事件流式渲染；`result` 事件标记请求结束并显示耗时；`error` 事件渲染为错误节点。
- 输入区：textarea 加 `Send`，运行中额外显示 `Cancel`。输入框只在 `Disconnected`、`Unavailable`、连接中三种状态禁用，运行中保持可用，占位文字变为 `Agent is working, type to steer it`。Enter 提交，Shift+Enter 换行。运行中提交调用 `submitInput(sessionId, input, { priority: 'now' })`；空闲时不带 priority。
- 恢复：沿用现有 localStorage 保存 `sessionId` 与游标、页面加载时 `resumeSession` 再 `readSession` 的逻辑。`readSession` 返回的历史消息渲染为紧凑的历史时间线（用户文本、助手文本、工具调用名与结果摘要），之后插入系统提示。本地持久化的时间线模型上限 200 个节点，超过丢弃最旧的。
- 样式：CSS 变量定义配色，`prefers-color-scheme: dark` 跟随系统；系统字体栈；不引入框架和外部资源；esbuild 打包方式不变。

### 5.4 脚手架：`createBladeAgent.ts`

- web preset 模板文件增加 `src/DemoProvider.mjs`，来源 `examples/web-agent-server/DemoProvider.mjs`。`server.mjs` 对它的导入是同目录相对路径，模板与生成项目里都成立。
- web preset 依赖增加 `open`，版本从 SDK 自身 manifest 的 dependencies 读取，与 esbuild 同一做法。
- 生成 `.gitignore`（`node_modules/`、`.blade/`、`.env`）与 `.env.example`（`OPENAI_API_KEY=`、`OPENAI_MODEL=`、`OPENAI_BASE_URL=`）。
- 新增 `--no-start`。默认行为：安装完成后，若 `process.stdout.isTTY` 且未指定 `--verify`、`--skip-install`、`--no-start`，以继承 stdio 的方式运行 `<包管理器> start`；key 提问与打开浏览器由 `server.mjs` 负责。`--verify` 的行为不变，仍运行 smoke。
- `webReadme` 按 9 步重写，包含环境变量、`--root`、`.blade/` 目录说明、“重启后继续”一节。

## 6. 9 步的关键数据流

- 创建与首次任务：浏览器 `createSession` 到 `AgentServer`，`InProcessSessionExecutor` 用 `resolveSessionOptions` 创建 Session，Session 的转录写入 `JsonlSessionRepository`。`submitInput` 触发模型循环，工具在沙箱内执行，每个流事件经 `store.appendEvent` 写入文件 store 的日志，再通过 SSE 到浏览器时间线。
- steering：浏览器 `submitInput` 带 `priority: 'now'`，executor 调用 `session.send` 同样带 priority，返回 `steered`；SDK 中断当前步骤并把新输入注入对话；provider 在下一次调用的 `messages` 里看到新的用户消息。
- 重启：进程退出。再次启动时 `JsonlAgentServerStore.initialize()` 回放并压缩。浏览器从 localStorage 取回 `sessionId` 调用 `resumeSession`，executor 从文件 store 读到会话记录，调用 `resumeSession({ ...options, sessionId })`，Session 从 `JsonlSessionRepository` 载入转录；`readSession` 返回消息与游标，界面渲染历史；新的输入在同一 Session 上继续。

## 7. 错误处理

- 日志写入失败：见 4.1。服务端记录错误，浏览器状态变为 `Unavailable`。
- 日志损坏：`initialize()` 抛错，`server.mjs` 打印错误与处理办法（删除 `.blade/server`）后以非零码退出。
- 沙箱缺失：Bash 走审批卡片；审批超时用 `AgentServer` 默认值。
- `npm` 不存在或命令失败：工具结果带错误文本，脚本化 provider 的报告如实写明；真实模型自行处理。
- `--root` 指向非 Node 项目：脚本化 provider 报告无 manifest 并列出顶层文件。
- 非 TTY 下无 key：静默进入脚本化 demo，打印一行说明。
- 浏览器打开失败：只打印 URL。

## 8. 测试

SDK（vitest，`src/server/__tests__/`）：

- `JsonlAgentServerStore.test.ts`：把 `InMemoryAgentServerStore` 现有行为测试以工厂方式对文件 store 再跑一遍，覆盖租约五个操作、session 读写与分页、`appendEvent` 幂等、`readEvents`、`getEventStreamRange`、`getLatestEventSequence`、`waitForEvents`。
- 重启回放：执行一组改动后 `close()`，同一目录新建实例 `initialize()`，逐项比对，包含超过保留窗口后仍可通过幂等键查到的事件，以及 sealed 租约恢复后仍拒绝再次 claim。
- 尾行截断被容忍并告警；文件中间损坏抛 `RUNTIME_STORE_CORRUPT_JOURNAL` 且消息含行号。
- 压缩：`initialize()` 之后文件行数等于 `snapshot()` 长度。
- 注入会失败的 journal：方法 reject，`healthCheck()` 返回 `ready: false`，后续改动方法 reject。
- `InMemoryAgentServerStore` 日志钩子：每种改动产生的条目类型与顺序；幂等重复 `appendEvent` 不产生条目；`restore(snapshot())` 状态等价。
- `restore` 在已有状态时抛错。

示例 smoke（`server.mjs --smoke`，同时是 `verify:create-agent` 的 web 步骤，两分钟预算不变）：

1. 用两个临时目录分别作为 `--data-dir` 与 `--root`，分析根里放一个含未锁定范围依赖且缺锁文件的 `package.json`。
2. 创建会话，提交任务，断言依次出现 Glob、Read、Bash 的 `tool_use`。
3. 收到首个 `tool_use` 后提交 `Focus on security issues` 带 `priority: 'now'`，断言返回 `steered`，断言最终报告含 `Focus adjusted: security`。
4. 若出现 `permission.requested`（无沙箱环境），smoke 客户端自动批准，范围为整个会话。
5. 关闭 `AgentServer` 与 store；同一目录新建 store 与 server；`resumeSession` 加 `readSession`，断言历史消息数与关闭前一致且包含报告文本。
6. 提交 `Continue the analysis`，断言结果含 `Continuing from the saved analysis`。

脚手架（`src/cli/__tests__/` 与 `scripts/verify-create-blade-agent.mjs`）：

- web preset 生成 `src/DemoProvider.mjs`、`.gitignore`、`.env.example`，依赖含 `open`。
- `--verify` 与非 TTY 下不自动启动。
- `verify:create-agent` 的 web 步骤运行新的 smoke 通过。

手工：macOS 上用真实 key 走 9 步，确认沙箱下 `npm audit` 可用；用 `--no-open` 与无沙箱路径确认审批卡片出现。

全量门禁：`pnpm lint`、`pnpm type-check`、`pnpm test`、`pnpm docs:build`、`pnpm changelog:check`、`pnpm verify:entrypoints`、`pnpm verify:install`、`pnpm verify:create-agent`。

## 9. 文件清单

SDK：

- `src/server/AgentServerStore.ts`：日志钩子、`restore`、`snapshot`、failed 状态
- `src/server/JsonlAgentServerStore.ts`：新增
- `src/server/RuntimeStore.ts`：新增错误码
- `src/server/runtime.ts`：导出
- `src/browser/server-only-stub.ts`：stub
- `src/server/__tests__/JsonlAgentServerStore.test.ts`：新增；`AgentServerStore` 现有测试改为工厂形式
- `docs/server-runtime.md`、`docs/en/server-runtime.md`
- `.changes/jsonl-agent-server-store.json`

示例与脚手架：

- `examples/web-agent-server/server.mjs`、`client.js`、`index.html`
- `examples/web-agent-server/DemoProvider.mjs`：新增
- `src/cli/createBladeAgent.ts`、`src/cli/create-blade-agent.ts`（`--no-start` 参数）、`src/cli/__tests__/`
- `scripts/verify-create-blade-agent.mjs`
- `examples/README.md`、`docs/golden-paths.md`、`docs/en/golden-paths.md`、`README.md`、`README.zh-CN.md`
- `.changes/web-preset-first-run.json`

## 10. 实施顺序

1. SDK 文件 store（独立，可先做并单独验证）
2. `server.mjs`：持久化、工具、沙箱、env 与 key、打开浏览器
3. `DemoProvider.mjs`
4. 界面时间线与 steering
5. smoke 覆盖 9 步
6. 脚手架、README、文档、changelog fragment
7. 全量门禁与 macOS 手工验证
