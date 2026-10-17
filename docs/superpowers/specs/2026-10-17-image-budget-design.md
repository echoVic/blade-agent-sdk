# 图片引用、视觉能力与图片预算（ImageRef / ImagePolicy / VisionCapability）

- 日期：2026-10-17
- 状态：待评审
- 分支：`feat/image-budget`
- 范围：`src/model`（图片与视觉能力契约）、新目录 `src/images`（入口规范化、请求投影、估算、store）、`src/context`（TokenCounter 与压缩）、`src/agent`（投影接入与恢复）、`src/tools`（工具结果图片、Read、MCP）、`src/session` 与 `src/protocol`（schema 与错误映射）、`src/server` 与 `src/browser`（上传与读取）、三个 preset 与示例
- 发版：全部是 7.x minor，按 §12 分三期

## 1. 目标

让图片在 SDK 里只有一种表示、一套能力声明、一个预算关口：

1. 三类来源都用 `ImageRef` 表示：用户粘贴或上传、工具产出、外部存储。
2. SDK 知道当前模型能不能看图、工具结果里能不能带图（`VisionCapability`），并按 `ImagePolicy` 处理。
3. 图片预算由 SDK 负责：每次发给模型的请求都在预算内，估算和压缩不再把 base64 当文本。
4. 7.x 兼容：旧数据、旧调用方式、旧版本对端继续可用。

成功标准：

- 1MB 截图的 token 估算小于 5k，耗时小于 50ms。现状是 954,409 tokens、1.2 秒（§2）。
- 压缩时发给摘要模型的 prompt 不含 `;base64,`。
- 一个回合里连续产生 60 张截图的工具循环：每次请求的历史图片估算不超过 `historyTokens`；多数相邻轮次的 prompt 前缀保持不变。
- 当前模型不收图时，新输入按策略拒绝或省略；历史图片不会让请求失败。
- Read 读 png、MCP 返回图片时，模型收到的是图片，不再是 base64 文本或 `[image: mime]`。
- web starter 里粘贴截图，经上传、引用，最终被模型收到。冒烟脚本在没有 API key 时覆盖这条链路。

## 2. 现状与差距

| 方面 | 现状 |
|---|---|
| 表示 | 只有 `{ type: 'image_url', image_url: { url } }`，没有 detail、mediaType 和尺寸。protocol、streamSchema、DurableRequestRecovery、`cloneContentPart` 四处重复定义；`cloneContentPart` 只拷贝 `url` |
| 能力 | 不区分模型。非视觉模型收到图片时 provider 返回 400，整个请求失败 |
| 估算 | `TokenCounter` 对数组 content 先 `JSON.stringify` 再分词。实测 1MB PNG 被估为 954,409 tokens，耗时 1.2 秒。`CompactionHandler` 在 microcompact 有替换时用它重估，一张截图就能越过 95% 线，触发 `slice(-40)` 紧急截断 |
| 压缩 | `buildCompactionSections` 把图片 part `JSON.stringify` 进摘要 prompt，base64 被按字节切块。按代码推算，128k 上下文下一张 1MB 图会切成约 12 块，每块一次摘要请求 |
| 历史 | 没有图片预算。所有历史图片每轮都重发，直到发生压缩 |
| 工具 | Read 读图片返回 base64 文本；MCP 返回的图片变成 `[image: mime]`；适配层的 tool message 只有文本 |
| 存储与传输 | JSONL、Postgres、durable journal 和 SSE 事件都内联 base64。AgentServer 命令体上限 1 MB，AgentClient SSE 单帧上限 4 MB |
| 协议错误 | `SessionInputError` 会落进 `INTERNAL_ERROR 500 retryable`，客户端会重试注定失败的输入 |

参考实现：

- Orca（`blade-deepseek`）：`supports_images`、`ImageRouteDecision`、`MAX_HISTORY_IMAGE_TOKENS`。
- codex：`ImageReference`（Inline / File）和 UnifiedImageBudget。

## 3. 范围

做：

- 契约：`ImageRef`、`ImageDetail`、`VisionCapability`、`ImagePolicy`、`ImageStore`、`TenantImageStore`。
- 入口规范化 `normalizeImages()`：用户输入、协议、上传、工具结果共用一套规则。
- 出口投影 `prepareImagesForRequest()`：能力判断、fresh 豁免、张数上限、历史预算与稳定裁剪、工具图片改放、引用解析与缓存。
- 估算器 `estimateImageTokens()`；修正 TokenCounter 和压缩；图片错误恢复。
- 工具结果图片：`ToolResult.images`、tool message 图片落盘、适配层的 `content` 输出、Read 和 MCP 返回图片。
- store：`InMemoryImageStore`、`FileImageStore`、`PostgresImageStore`、`combineImageStores()`、`prune()` 和 `delete()`。
- 服务端：AgentServer 的上传和读取路由；AgentClient 的 `uploadImage()` 和 `fetchImage()`。
- preset 与示例：local、web、production 三个 preset 默认启用 store；web starter 支持粘贴截图，冒烟增加图片步骤；production-stack 示例接上 store。
- 文档与双语 changelog。

不做：

- 图片缩放与重编码。SDK 不引入图像库，超限图片按策略拒绝，由应用自己预处理。
- 非视觉模型的"先转述再继续"，即 Orca 的 DescribeThenContinue。本期用占位文本加 `alt`；以后可以在 `ImagePolicy` 上加转述钩子。
- 子 agent 输入带图。Task 工具的 prompt 只有文本。
- 按引用计数自动回收图片。本期只提供按时间清理（§8.1）。
- 音频、视频、PDF 等其他模态。
- 协议能力标志。`initialize` 两个方向的 schema 都是 strict，新增 key 会让旧版本对端解析失败（§4.7）。
- 降级兼容。新版本写入的 store 引用不保证能被 7.4 读取。

## 4. 契约

### 4.1 ImageRef

`src/model/image.ts`（新文件）：

```ts
export type ImageDetail = 'auto' | 'low' | 'high';

/** 一张对模型可见的图片。`url` 是 data: URL、http(s) URL 或 store 引用。 */
export interface ImageRef {
  url: string;
  detail?: ImageDetail;
  /** image/png | image/jpeg | image/gif | image/webp */
  mediaType?: string;
  /** 入口从文件头解析，供预算估算使用。 */
  width?: number;
  height?: number;
  byteLength?: number;
  /** 图片不能发给模型时，用于生成占位文本。 */
  alt?: string;
}
```

`src/model/message.ts`：

```ts
export interface ModelImageContent {
  type: 'image_url';
  image_url: ImageRef; // 原来是 { url: string }
}
```

不新增 content part 类型，`ModelContent` 联合保持不变，按 `part.type` 穷举的调用方不用改。只有 `{ url }` 的旧数据仍是合法的 `ImageRef`。

### 4.2 引用形式

| 形式 | 例子 | 由谁解析 |
|---|---|---|
| 内联 | `data:image/png;base64,…` | 不需要解析 |
| 远程 | `https://…` | 原样交给 AI SDK。和今天一样，provider 不支持 URL 时由 AI SDK 下载 |
| SDK store | `blade-image:sha256:<64 位十六进制>` | 内置 store |
| 应用 scheme | `lark-image:img_v3_…`、`s3://bucket/key` | 应用实现的 `ImageStore` |

内置 store 按内容寻址：同一租户内相同字节只存一份，引用就是摘要。

### 4.3 VisionCapability

`src/model/vision.ts`（新文件）：

```ts
export interface VisionCapability {
  images: boolean;
  /** 为 false 时，投影把工具结果里的图片改放到紧随其后的 user 消息。 */
  toolResultImages: boolean;
  mediaTypes?: readonly string[];
  maxImageBytes?: number;
  maxImagesPerRequest?: number;
  /** 估算公式；数字表示每张固定 token 数。 */
  imageTokens?: 'openai' | 'anthropic' | 'gemini' | number;
}

export type VisionCapabilityOverride = Partial<VisionCapability>;

export type VisionResolver = (model: {
  readonly provider: string;
  readonly model: string;
}) => VisionCapabilityOverride | undefined;
```

配置位置：

- `ModelConfig.vision?: VisionCapabilityOverride`：用于已注册的模型。
- `SessionOptions.vision?: VisionCapabilityOverride | VisionResolver`：
  - 对象形式作用于 Session 当前使用的模型，语义和 `maxContextTokens` 一样，`setModel` 之后仍然生效。
  - 函数形式按模型返回覆盖值；返回 `undefined` 时使用默认表。
  - `AgentOptions.advanced.vision` 原样透传。
- 解析结果（完整的 `VisionCapability`）写进 `ModelServiceConfig.vision`，供 `ProviderRegistry` 里的自定义 adapter 读取。

解析顺序。在 `ModelManager.applyModelConfig` 中执行，结果和 `maxContextTokens` 保存在一起：

1. 用内置默认表（见下表）得到基线；
2. 叠加 `ModelConfig.vision`；
3. 叠加 `SessionOptions.vision`，函数形式先求值；
4. 叠加本 Session 内的运行期降级（§7.4）。

投影读取 ModelManager 保存的结果，所以不依赖自定义 `ModelService.getConfig()` 是否回显 `vision`。

内置默认表放在 `src/images/visionDefaults.ts`，和 `isThinkingModel` 一样按 provider 与模型名匹配：

| provider | 模型 | images | toolResultImages | imageTokens | 其他 |
|---|---|---|---|---|---|
| anthropic | `claude-2*`、`claude-instant*` 以外 | ✓ | ✓ | anthropic | maxImageBytes 5 MiB，maxImagesPerRequest 100 |
| openai | `gpt-3.5*`、`gpt-4`、`gpt-4-0314`、`gpt-4-0613`、`gpt-4-32k*`、`o1-mini*`、`o1-preview*`、`o3-mini*` | ✗ | ✗ | — | |
| openai | 其他 | ✓ | ✓ | openai | maxImageBytes 20 MiB |
| azure-openai | 模型名规则与 openai 相同 | 同 openai | ✗ | openai | |
| gemini | 全部 | ✓ | ✓ | gemini | |
| deepseek | 别名归一后为 `deepseek-v4-flash` | ✓ | ✗ | 1600 | |
| deepseek | 其他（`deepseek-v4-pro`、`deepseek-r1*`） | ✗ | ✗ | — | |
| 其他（含 openai-compatible） | 名称含 `qwq`、`deepseek-r1`、`deepseek-v4-pro`、`o1-mini`、`o3-mini`、`gpt-3.5` | ✗ | ✗ | — | |
| 其他（含 openai-compatible） | 其余 | ✓ | ✗ | 1600 | |

依据：

- `@ai-sdk/openai` 3.0.112 默认走 Responses API，工具结果的 `content` 输出会转成 `input_image`。anthropic 和 google adapter 也支持工具结果里带图。
- `@ai-sdk/openai-compatible` 和 `@ai-sdk/deepseek` 会把工具结果的 `content` 输出 `JSON.stringify` 成文本，所以这两类默认改放。
- DeepSeek 两行取自 Orca 的内置模型表：Flash 是多模态，Pro 不收图。
- 不认识的模型保持今天的直接透传；如果猜错，由 §7.4 的运行期降级纠正。

### 4.4 ImagePolicy

定义在 `src/images/ImagePolicy.ts`，配置在 `SessionOptions.images`，`AgentOptions.advanced.images` 原样透传：

```ts
export interface ImagePolicy {
  /** 不配置时图片保持内联，与今天一致。 */
  store?: ImageStore;
  /** 单张字节上限；默认 10 MiB，并受 vision.maxImageBytes 约束。 */
  maxImageBytes?: number;
  /** 每次输入的图片张数上限；默认 20。 */
  maxImagesPerInput?: number;
  /** 历史图片预算；默认 min(16_000, 输入窗口的 25%)。 */
  historyTokens?: number;
  /** 单次请求的张数硬上限；默认取 vision.maxImagesPerRequest，未声明时为 50。 */
  maxImagesPerRequest?: number;
  /** 模型不收图时新输入怎么处理；默认 'reject'。 */
  whenUnsupported?: 'reject' | 'omit';
  /** 是否接受调用方给出的 http(s) 图片；默认 true。SDK 自己从不抓取这类 URL。 */
  remoteUrls?: boolean;
}
```

输入窗口 = `maxContextTokens − maxOutputTokens`，与 `CompactionHandler` 的算法一致。128k 上下文、8k 输出时，默认预算为 16k，约等于 10 张 1080p 截图。

### 4.5 ImageStore

`src/images/ImageStore.ts`：

```ts
export type ResolvedImage =
  | { readonly bytes: Uint8Array; readonly mediaType: string }
  | { readonly url: string }; // 例如预签名 URL，由 provider 自己去取

export interface ImageStore {
  handles(url: string): boolean;
  put(
    image: { readonly bytes: Uint8Array; readonly mediaType: string },
    signal?: AbortSignal,
  ): Promise<ImageRef>;
  get(url: string, signal?: AbortSignal): Promise<ResolvedImage | undefined>;
  delete?(url: string): Promise<void>;
}

export interface TenantImageStore {
  forTenant(tenantId: string): ImageStore;
}

export function combineImageStores(primary: ImageStore, ...others: ImageStore[]): ImageStore;
```

- `put` 返回带完整元数据的 `ImageRef`：mediaType、width、height、byteLength。
- `combineImageStores`：`put` 写入 primary；`handles`、`get`、`delete` 交给第一个认领该引用的 store。应用的 IM key、对象存储 scheme 都通过它接入。
- 内置实现见 §8.1。

### 4.6 导出与归属

| 入口 | 新增 |
|---|---|
| 根入口（含 browser 构建） | 类型 `ImageRef`、`ImageDetail`、`VisionCapability`、`VisionCapabilityOverride`、`VisionResolver`、`ImagePolicy`、`ImageStore`、`TenantImageStore`、`ResolvedImage`；值 `InMemoryImageStore`、`combineImageStores`、`imageFromBytes` |
| `/advanced` | `FileImageStore`。它使用 `node:fs`，browser stub 要同步补齐 |
| `/server/postgres` | `PostgresImageStore` |
| `/browser` | `AgentClient.uploadImage()`、`AgentClient.fetchImage()` |

根入口新增的实现都不依赖 `node:*`，base64 编解码用平台无关的实现。

### 4.7 7.x 兼容性

- 类型：`ImageRef` 是 `{ url }` 的超集。`ToolResult.images`、`SessionOptions.images`、`SessionOptions.vision`、`ModelConfig.vision`、`ModelServiceConfig.vision` 全部可选。
- 数据：旧 transcript、journal 和事件里的 `{ url }` 原样可读，不做迁移。缺失的元数据在估算时按需解析。
- 对端：
  - 旧客户端连新服务端：不受影响。
  - 新客户端连旧服务端：只发 `{ url }` 时正常；带 `detail` 等新字段会被旧服务端的 strict schema 拒绝。文档注明新字段需要 7.5 及以上的服务端。
  - 不在 `initialize.features` 里加 `images` 标志，因为旧客户端的 strict schema 会拒绝未知 key。客户端通过上传路由是否存在来判断服务端是否支持（§8.3）。同时把客户端对 `features` 的解析放宽为接受未知 key，给以后的标志留路。
- 默认行为变化，全部写进 CHANGELOG：
  - 发给模型的请求会按预算省略旧图，按能力省略或改放图片；
  - Read 对图片文件返回图片，不再返回 base64 文本；
  - MCP 返回的图片不再丢失；
  - 图片输入错误从 500 改为 400；
  - TokenCounter 对图片的估算值大幅下降。
- 不变：没配 `images.store` 时，`session.messages` 和持久化内容里的图片仍是调用方给的 url，只是多了元数据字段。

## 5. 入口：normalizeImages

### 5.1 规则

`normalizeImages(parts, { policy, vision, store })` 逐张处理图片 part：

1. `data:`：
   - 解码之前先按 base64 长度估算字节数。超过 `min(policy.maxImageBytes, vision.maxImageBytes)` 就拒绝（`too_large`），不分配内存。
   - 解码之后按文件魔数判定类型：只收 png、jpeg、gif、webp；svg 一律拒绝；声明的 mediaType 和魔数不符也拒绝（`media_type`）。
   - 从文件头读取宽高（png 的 IHDR、jpeg 的 SOF、gif 的逻辑屏幕描述符、webp 的 VP8、VP8L、VP8X），并记录 byteLength。不依赖图像库。
2. `http(s):`：`policy.remoteUrls === false` 时拒绝（`remote_url`）。SDK 不去抓取，元数据保持未知。
3. 其他 scheme：必须有 store 认领（`store.handles(url)`），否则拒绝（`unresolvable`）。这里不检查引用是否真实存在，缺失的引用在出口会变成占位。
4. 张数：超过 `maxImagesPerInput` 时拒绝（`too_many`）。
5. 视觉能力：`vision.images === false` 时：
   - `whenUnsupported: 'reject'` 直接拒绝（`unsupported_model`）；
   - `'omit'` 照常接受，图片留在 transcript 里，由投影替换成占位。
6. 外置：配置了 store 时调用 `put()`，把 url 改写为 store 引用并补全元数据；没配 store 时保留 `data:`，只补元数据。

### 5.2 接入点

| 来源 | 位置 | 失败时 |
|---|---|---|
| `session.send()`、`prompt()`、插话、`agent.send()` | `SessionRequestCoordinator.send()` 的最开头，在获取 input mutex 之前。所以 durable `recordAccepted` 和 JSONL `saveInputEnqueued` 记录的已经是规范化之后的结果 | 抛 `SessionInputError` |
| 协议 `input.submit` | 同上（`InProcessSessionExecutor.submit` 调用 `session.send`） | 映射成 `INVALID_COMMAND` 400，不可重试 |
| `POST {base}/images` | AgentServer 路由（§8.2），规则相同 | 400 或 413 |
| 工具结果 | `ResultNormalizer.normalize()`。hooks 和历史看到的已经是规范化之后的结果 | 去掉这张图，在 `model` 文本末尾附一行说明；工具状态不变 |

工具结果相关的改动：

- `ToolResultBase.images?: readonly ImageRef[]`，内容 JSON-safe，可以进入 durable journal。
- 新导出 `imageFromBytes(bytes, mediaType, { detail?, alt? }): ImageRef`，生成 data URL 并填好元数据，给工具作者用。配置了 store 时由 `ResultNormalizer` 负责外置。
- `AgentLoop.appendToolResult`：有图片时，tool message 的 content 为 `[{ type: 'text', text }, ...图片 part]`。
- `SessionEventStore.saveToolResult` 增加可选的末位参数 `images`。`ProjectedSessionRepository` 及其子类（JSONL、Postgres、Noop）把它写进 tool message 的 content。忽略这个参数的自定义实现，恢复会话后只剩文本。
- Read：读 `.png .jpg .jpeg .gif .webp` 且 encoding 为默认值时，返回 `images: [ref]` 和 `model: 'Image file a.png (image/png, 1280×720, 214 KB)'`。显式传 `encoding: 'base64'` 时保持原行为；其他二进制类型不变。
- MCP：`{ type: 'image', data, mimeType }` 转成 `images` 条目。

### 5.3 错误

```ts
export type SessionInputErrorCode =
  | 'SESSION_INPUT_QUEUE_FULL'
  | 'SESSION_REQUEST_MISMATCH'
  | 'SESSION_STEERING_UNAVAILABLE'
  | 'SESSION_INPUT_OPTIONS_UNSUPPORTED'
  | 'SESSION_INPUT_IMAGE_REJECTED';

export type ImageRejectionReason =
  | 'unsupported_model'
  | 'too_large'
  | 'too_many'
  | 'media_type'
  | 'remote_url'
  | 'unresolvable';
```

`SessionInputError` 增加可选字段 `details: { index: number; reason: ImageRejectionReason }`。

`InProcessSessionExecutor.submit` 把所有 `SessionInputError` 映射成协议错误。现在它们都会落进 `INTERNAL_ERROR 500 retryable`。

| SessionInputError | 协议错误 |
|---|---|
| `SESSION_INPUT_IMAGE_REJECTED` | `INVALID_COMMAND` 400，带 `details` |
| `SESSION_INPUT_OPTIONS_UNSUPPORTED` | `INVALID_COMMAND` 400 |
| `SESSION_REQUEST_MISMATCH`、`SESSION_STEERING_UNAVAILABLE` | `SESSION_CONFLICT` 409 |
| `SESSION_INPUT_QUEUE_FULL` | `OVERLOADED` 503，可重试 |

## 6. 出口：prepareImagesForRequest

### 6.1 接入点

在 `runTurn()` 调用 `ModelService` 之前执行。主循环和子 agent 的模型调用都经过 `runTurn`；压缩的 `sideQuery` 只有文本（§7.3）。ModelMiddleware 和自定义 ModelService 收到的都是投影之后的消息。

投影只用于本次请求，不写回 `ConversationState`、transcript 或存储。

`TurnState` 需要携带这些内容：解析后的 `vision`、解析后的 `ImagePolicy`、store、Session 级的解析缓存，以及本轮是否是恢复重试（§7.4）。

### 6.2 算法

1. 快速路径：没有任何图片 part 时直接返回原数组。
2. 收集图片槽位：消息下标、part 下标、所属 role、tool_call_id、估算成本。只有 user 和 tool 消息里的图片参与计算；system 和 assistant 消息里的图片替换成占位，因为 provider 不接受。
3. 标记 fresh：最后一条 assistant 消息之后的图片，也就是模型还没看过的输入和工具结果。
4. `vision.images === false` 时：全部替换成"不收图"占位，结束。
5. 张数上限 `maxImagesPerRequest`：fresh 图片按从新到旧先占名额，放不下的替换成预算占位；剩余名额留给历史图片。
6. 历史预算：历史图片按从旧到新累加成本，合计为 T，预算 B = `historyTokens`。
   - T ≤ B 时全部保留；
   - 否则按 §6.3 确定裁剪点，裁剪点之前的替换成预算占位；
   - 保留的张数同时受剩余名额约束，名额不够时同样按 §6.3 步进裁剪。
7. 工具结果里的图片：`vision.toolResultImages === false` 时按 §6.4 改放。
8. 解析保留下来的引用（§6.5）。
9. `detail`：在适配层映射成 `providerOptions.openai.imageDetail`，其他 provider 忽略。

只复制发生了变化的消息，其余消息保持原对象。

### 6.3 稳定裁剪

需要省略的成本为 D = T − B。实际裁剪量取 `⌈D / S⌉ × S`，步长 S = B / 2。从最旧的图片开始省略，直到累计省略的成本不小于裁剪量。B 为 0 时省略全部历史图片。

- 新图片进来时 D 会变大，但在越过下一个 S 的整数倍之前，裁剪点保持不动。prompt 前缀因此不变，provider 的前缀缓存持续命中。
- 保留下来的历史成本不超过 B。单张成本远小于 B 时，大致落在 [B/2, B] 之间；单张成本接近或超过 S 时，可能更少。
- 结果只依赖 transcript 和配置，没有内部状态，进程重启或 durable 恢复之后结果相同。
- 张数约束按同样方式步进，步长为名额的一半，至少为 1。

### 6.4 工具结果图片改放

对一组连续的 tool 消息：

- 每条带图的 tool message 只保留文本，并追加 `[N image(s) from this result are attached in the next message]`。
- 在这组 tool 消息之后插入一条 user 消息。每个工具调用一段，先写 `Images returned by <toolName> (<toolCallId>):`，后面接对应的图片。

支持工具结果带图的 provider，适配层把 tool message 转成：

```ts
output: {
  type: 'content',
  value: [{ type: 'text', ... }, { type: 'image-data', data, mediaType } | { type: 'image-url', url }],
}
```

### 6.5 解析与缓存

- `data:` 和 `http(s):` 原样传递。
- store 引用调用 `get()`：
  - 返回字节时转成 data URL；
  - 返回 `{ url }` 时直接传 url；
  - 返回 `undefined` 或抛错时替换成"不可用"占位，记一条 warn，本轮继续。
- 解析结果放进 Session 级的 LRU 缓存，按字节计，默认上限 64 MiB。只解析保留下来的图片。

### 6.6 占位文本

都是确定性文本，不含时间戳或随机值：

```
[image omitted to fit the image budget: image/png 1280×720 — <alt>]
[image omitted: the current model does not accept images — <alt>]
[image unavailable: it is no longer in the image store]
```

元数据缺失时省略对应字段；没有 `alt` 时省略 ` — <alt>` 这一段。

### 6.7 可观测性

只要有图片被省略，就记一条 debug 日志，并在当前 turn span 上记录 `images.kept`、`images.omitted.budget`、`images.omitted.unsupported`、`images.omitted.unavailable` 和 `images.estimatedTokens`。不新增流事件类型。

## 7. 估算、压缩与恢复

### 7.1 estimateImageTokens

`estimateImageTokens(ref, vision): number`：

| 公式 | 规则 |
|---|---|
| openai | detail 为 low 时固定 85；否则先缩放到 2048×2048 以内，再把短边缩到 768，按 512 切块，`85 + 170 × 块数` |
| anthropic | 长边缩到 1568 以内、面积缩到约 1.15 MP 以内，`⌈宽 × 高 / 750⌉` |
| gemini | 两边都不超过 384 时为 258；否则按 768 切块，每块 258 |
| 数字 | 每张固定为该值 |

- 宽高优先取 `ImageRef` 里的值。旧的 `data:` 图片没有元数据，只解码前 64 KB 来读文件头。
- 仍然未知时取 1,600。1080p 截图按三种公式算分别约为 1,105、1,535、1,548。
- 任何情况下都不对 base64 分词。

### 7.2 TokenCounter

签名改为 `countTokens(messages, modelName, options?: { vision?: VisionCapability })`：文本 part 用 tiktoken 计数，图片 part 用 `estimateImageTokens`。`CompactionHandler` 和 `compact()` 里的估算调用传入当前模型的 `vision`。

### 7.3 压缩

- `buildCompactionSections` 把图片渲染成 `[image: image/png 1280×720 — <alt>]`，不再 `JSON.stringify` content。
- 压缩后保留下来的消息里，图片仍以引用形式存在，由投影继续按预算处理。
- `microcompact()` 和 `softCompact()` 增加对数组 content 的处理：压缩其中的文本 part，图片 part 不动。它们现在只处理字符串 content，阶段 2 之后带图的 tool message 会被跳过。

### 7.4 图片错误恢复

- 新增 `isImageLimitError(error)`：沿 cause 链匹配 provider 的错误文案。具体文案集中维护，并有测试覆盖：
  - 张数超限：`too many images`、vLLM 的 `At most N image(s)`；
  - 单张过大：`exceeds 5 MB`、`image too large`；
  - `invalid image`；
  - 不支持图片：`does not support image`、`image input is not supported`。
- 处理：
  - 复用 `AgentLoop` 现有的恢复状态机，与 reactive compact 共用"每轮最多一次"的约束。
  - 命中时重试本轮，投影使用收紧模式：历史图片全部省略；fresh 图片的保留张数减为失败那次请求的一半，向下取整，至少保留 1 张。
  - 上下文溢出触发 reactive compact 后的重试轮，同样使用收紧模式。
- 不支持图片类的错误：同时把当前模型在本 Session 内的 `vision.images` 记为 false（§4.3 第 4 步），之后的请求直接用占位。这个标记只保存在内存里，Session 重建后重新判断。
- 重试仍然失败时，错误原样抛出，与今天一致。
- `recovery` 事件新增 reason `'image_limit'`。它属于内部 `AgentEvent`，对外的事件 schema 不变。

## 8. 存储与服务端

### 8.1 内置 store

| 实现 | 入口 | 设计 |
|---|---|---|
| `InMemoryImageStore({ maxBytes })` | 根入口 | 默认 256 MiB，按总字节做 LRU。被淘汰的引用在出口变成"不可用"占位 |
| `FileImageStore({ directory })` | `/advanced` | 路径为 `<directory>/<租户目录>/<sha 前 2 位>/<sha>.<ext>`。用 write-file-atomic 原子写入，文件已存在时跳过，写入是幂等的。租户目录名会做编码，避免出现 `:` 之类的字符 |
| `PostgresImageStore` | `/server/postgres` | 表 `<prefix>_images (tenant_id, sha256, media_type, byte_length, width, height, data BYTEA, created_at)`，主键 `(tenant_id, sha256)`。建表用 `CREATE TABLE IF NOT EXISTS`，不提升 `RUNTIME_STORE_SCHEMA_VERSION`，已有的库可以直接使用。获取方式有两种：通过 `PostgresRuntimeStore` 的 `forTenant(t).images` 获得，建表在 `PostgresRuntimeStore.initialize()` 中完成；也可以用同一个 pool 单独构造，由它自己的 `initialize()` 建表。`RuntimeTenantStore` 增加可选字段 `images?: ImageStore` |

- 三种实现都同时实现 `ImageStore` 和 `TenantImageStore`。直接当 `ImageStore` 用时，对应默认租户。
- 回收：
  - 都提供 `prune({ olderThan: Date }): Promise<number>`，按写入时间删除，返回删除的数量；另外提供 `delete(url)`。
  - 被删掉的引用在出口变成"不可用"占位，会话不会报错。
  - 不做自动回收，因为内容寻址的同一张图可能被多个 session 和 fork 共用。
- 三种实现跑同一套契约测试。

### 8.2 AgentServer

新增选项：

```ts
readonly images?: {
  readonly store: TenantImageStore;
  /** 上传单张图片的字节上限；默认 10 MiB，与命令体上限 maxRequestBytes 无关。 */
  readonly maxUploadBytes?: number;
};
```

配置之后：

- **注入到 Session**：Session options 里没有 `images.store` 时，注入 `store.forTenant(principal.tenantId)`；`resolveSessionOptions` 已经显式设置的，以应用为准。
- **`POST {base}/images`**：
  - 需要 `session:write` scope，和命令一样经过 `TenantAdmissionController.acquire()`。
  - 请求体是原始字节；`content-type` 必须是 png、jpeg、gif、webp 之一，且与魔数一致；在 `content-length` 和流式读取两个阶段都检查大小。
  - 成功返回 `200 { image: ImageRef }`。失败时返回 `AgentCommandFailure` 形状的错误体：过大是 413，类型或魔数不对是 400；`details.reason` 的取值和 §5.3 相同。
- **`GET {base}/images/{encodeURIComponent(url)}`**：
  - 需要 `session:read` scope，只查本租户。
  - 响应的 `content-type` 取自 store，只可能是四种栅格类型；同时带 `x-content-type-options: nosniff` 和 `cache-control: private, max-age=31536000, immutable`。
  - 查不到时返回 404。
- 没有配置 `images` 时，两条路由返回现有的 404 `Route not found`。
- **Worker 部署**：AgentServer 和 AgentWorker 共用 `PostgresRuntimeStore`，图片在同一张表里。worker 一侧的 Session 通过 `RuntimeTenantStore.images` 拿到 store。

### 8.3 AgentClient

```ts
uploadImage(
  data: Blob | ArrayBuffer | Uint8Array,
  options?: { mediaType?: string; signal?: AbortSignal },
): Promise<ImageRef>;

fetchImage(url: string, options?: { signal?: AbortSignal }): Promise<Blob>;
```

- `uploadImage`：
  - 收到 404 时抛 `AgentProtocolError`，`details.reason = 'images_unsupported'`；
  - 收到 413 或 400 时抛带 `details.reason` 的 `AgentProtocolError`。
- `fetchImage` 用来渲染 transcript 和事件里的 store 引用。`<img>` 标签不能带鉴权头，所以先取 Blob，再用 `URL.createObjectURL` 渲染。
- `RemoteAgentSession.send()` 不变，直接接受带 `ImageRef` 的 content。

### 8.4 部署拓扑

| 拓扑 | store | 说明 |
|---|---|---|
| 进程内的 `createSession` / `createAgent` | 显式配置；不配置时内联 | 用 `InMemoryImageStore` 时，图片随进程结束而释放 |
| JSONL（配置了 `storagePath`） | 建议用 `FileImageStore` | 能恢复的 Session，必须配一个能恢复的 store |
| AgentServer + JSONL store（web preset） | `FileImageStore`，放在 data 目录下 | |
| AgentServer + AgentWorker + Postgres（production） | `PostgresImageStore` | 所有可能恢复该 Session 的进程共用同一个 store |

文档里写明：durable 恢复要求恢复进程能解析同一批引用。

### 8.5 preset 与示例

- **local preset**：生成的代码配置 `FileImageStore`，目录为 `.blade/images`。
- **web preset 与 `examples/web-agent-server`**：
  - `AgentServer` 配置 `images.store = new FileImageStore({ directory: <dataDir>/images })`；
  - 时间线 UI 支持粘贴和拖入截图：先 `uploadImage`，再带引用发送，消息里用 `fetchImage` 显示缩略图；
  - `DemoProvider` 识别图片输入，回复图片的尺寸；
  - 冒烟在原有 9 步之外增加一步：上传一张生成的 PNG，检查回复里的尺寸和时间线里的缩略图。原来的 9 步不变。
- **production preset 与 `examples/production-stack`**：接上 `PostgresImageStore`，让 `QueuedSessionExecutor` 路径上的 Session 拿到 store。
- `scripts/verify-create-blade-agent.mjs` 里的期望同步更新。

## 9. 错误处理汇总

| 场景 | 行为 |
|---|---|
| 用户输入的图片不合格 | `SessionInputError('SESSION_INPUT_IMAGE_REJECTED', { index, reason })`；协议侧 400，不可重试 |
| 上传的图片不合格 | 400 或 413，带 `details.reason` |
| 工具产出的图片不合格 | 去掉这张图，在 `model` 文本里附说明，工具状态不变 |
| 入口处 `store.put` 失败 | `send()` 抛出 store 的错误，不降级为内联 |
| 出口处 `store.get` 失败或引用缺失 | 这次请求里换成占位，记 warn，本轮继续 |
| provider 因图片拒绝请求 | 按收紧模式重试一次（§7.4），仍然失败就原样抛出 |
| 当前模型不收图 | 新输入按 `whenUnsupported` 处理；历史图片和工具图片一律换成占位，不让请求失败 |

## 10. 测试

单元测试：

- 文件头解析：png、jpeg（baseline、progressive、EXIF 在 SOF 之前）、gif、webp（VP8、VP8L、VP8X），以及截断、损坏、超长段的文件。
- 魔数识别：拒绝 svg，拒绝声明类型与魔数不符的文件。
- `estimateImageTokens`：三种公式用 provider 文档里的例子做表驱动测试，例如 openai 1024×1024 high detail 为 765；尺寸未知时取默认值。
- 默认能力表和解析顺序：覆盖值、函数形式、运行期降级。
- `normalizeImages`：每一种拒绝原因；外置和不外置两种情况；`'omit'`。
- `prepareImagesForRequest`：
  - 快速路径返回同一个数组；
  - 模型不收图时全部换成占位；fresh 图片豁免预算；张数上限生效；
  - 稳定裁剪：在 60 张截图的多轮模拟里结果确定、按 B/2 步进，裁剪点不动的相邻两轮前缀完全相同；
  - 改放的位置和文本；detail 映射；引用缺失和 `get` 抛错；LRU 不超过字节上限。
- TokenCounter 回归：1MB 图片的估算小于 5k tokens，耗时小于 50 ms。
- 压缩：prompt 里不含 `;base64,`；microcompact 和 softCompact 能处理数组形式的 content。
- `isImageLimitError` 的文案集；收紧重试只发生一次；不支持图片类的错误会触发降级。
- schema：protocol、streamSchema、DurableRequestRecovery 同时接受 `{ url }` 和新字段；`cloneContentPart` 保留新字段。
- Read 读图片和显式 base64 两种情况；MCP 图片的转换。
- `SessionInputError` 到协议错误的映射。

集成测试（用 mock provider 和 ProviderRegistry）：

- 发图之后，模型收到的是解析后的 data URL；配置了 store 时，transcript 和 journal 里只有引用。
- JSONL 恢复会话后，工具结果里的图片还在；只有 `{ url }` 的旧 durable 记录可以恢复。
- 视觉模型和非视觉模型来回切换：先变成占位，切回来后图片重新带上。
- 工具结果图片：在 openai-compatible 下被改放，在 anthropic 下留在 tool message 里（检查适配层输出）。
- AgentServer：
  - 上传和读取；租户隔离，租户 B 读不到租户 A 的图片；
  - scope 校验；413；拒绝 svg；`nosniff` 响应头；未配置时返回 404；
  - 上传之后带引用调用 `input.submit` 能走通。
- 三种 store 的契约测试。Postgres 的 SQL 用 fake pool 测；真实数据库上的契约放进 production-stack 冒烟（docker）。

示例与发版前检查：

- web 冒烟新增的图片步骤；production-stack 冒烟。
- `verify:entrypoints`，覆盖新导出和 browser stub。
- `type-check`、`lint`、`test`、`changelog:check`。

## 11. 文档

中英文同步：

- `docs/session.md`：新增"图片"章节，介绍 ImageRef、ImagePolicy、store、预算与占位、部署要求。
- `docs/providers.md`：VisionCapability、默认能力表、覆盖方式；提醒未知 openai-compatible 模型要配置 `maxImagesPerRequest`（vLLM 默认每次只收 1 张）。
- `docs/tools.md`：`ToolResult.images`、`imageFromBytes`、Read 和 MCP 的变化。
- `docs/server-runtime.md`：上传和读取路由、`images` 选项、部署拓扑。
- `docs/api-reference.md`：新增的导出。
- 双语 CHANGELOG：每期的新增内容，以及 §4.7 列出的默认行为变化。

## 12. 分期与发版

| 期 | 版本 | 内容 |
|---|---|---|
| 1 核心 | 7.5.0 | §4 的契约；视觉能力默认表与解析；文件头解析与估算器；TokenCounter 与压缩的修复；`normalizeImages`（用户输入与协议）；`prepareImagesForRequest`（不含改放）；`ImageStore` 端口、`InMemoryImageStore`、`combineImageStores`；图片错误恢复；schema 与 `cloneContentPart`；`SessionInputError` 的协议映射 |
| 2 工具结果 | 7.6.0 | `ToolResult.images`、`imageFromBytes`；`ResultNormalizer`；tool message 图片与 `saveToolResult`；适配层的 `content` 输出与改放；microcompact、softCompact 对数组 content 的处理；Read 与 MCP |
| 3 持久化与服务端 | 7.7.0 | `FileImageStore`、`PostgresImageStore`、`prune` 与 `delete`；AgentServer 的上传和读取；AgentClient；三个 preset、web starter、production-stack |

每一期都要等 `type-check`、`lint`、`test` 和相关冒烟全部通过之后再发版。

## 13. 已知限制

- 估算值和 provider 的实际计费有偏差。是否触发压缩，仍以 provider 返回的真实 usage 为准。
- 默认能力表会随 provider 更新而过时。可以手动覆盖；如果把不支持图片的模型猜成支持，运行期降级会纠正；反过来猜错时需要显式覆盖。
- 未知 openai-compatible 模型的单次图片上限无法探测，vLLM 默认每次只收 1 张。需要配置 `vision.maxImagesPerRequest`，否则第一次超限时由收紧重试兜底。
- `prune` 按写入时间清理，所以仍在使用的旧图片也会被清掉；被清掉的引用会变成占位。
- 新版本写入的 store 引用，降级到 7.4 后无法解析。
