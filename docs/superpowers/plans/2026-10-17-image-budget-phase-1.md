# 图片引用、视觉能力与图片预算 · 第 1 期（7.5.0 核心）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 SDK 具备三样东西：统一的图片引用 `ImageRef`、按模型解析的视觉能力 `VisionCapability`、Session 级的图片策略 `ImagePolicy`。图片在 `send()` 入口校验，并可写入 `ImageStore`；每次模型请求前按能力和预算做投影；token 估算和压缩不再把 base64 当文本。

**Architecture:**
- 契约放在 `src/model`（`ImageRef`、`VisionCapability`）。
- 运行时放在新目录 `src/images`：文件头解析、token 估算、视觉能力默认表、入口规范化 `normalizeImageContent`、预算选择 `selectImages`、请求投影 `prepareImagesForRequest`，以及把它们串起来的 `ImageRuntime`。
- `ImageRuntime` 由 `SessionRuntime` 创建，经 `AgentRuntimeDeps` 交给 Agent；Agent 把 `ModelManager` 解析出的视觉能力绑定进去。
- 出口：`runTurn` 在调用 `ModelService` 之前投影。入口：`SessionRequestCoordinator.send()` 做规范化。
- transcript 从不被改写。

**Tech Stack:** TypeScript（ESM，Node >= 22.14）、vitest、biome、zod（schema）、lru-cache（已有依赖）、Web Crypto（`globalThis.crypto.subtle`）、Vercel AI SDK 6（`ai` 6.0.282、`@ai-sdk/openai` 3.0.112）。

**Spec:** `docs/superpowers/specs/2026-10-17-image-budget-design.md`。本计划实现其中 §12 的第 1 期。第 2 期（工具结果带图）和第 3 期（File/Postgres store、服务端上传）另写计划。执行每个任务前先读 spec 的对应章节。

## Global Constraints

- **运行环境**：Node.js `>=22.14.0`，ESM only；TypeScript 相对导入必须带 `.js` 后缀。
- **代码风格**：由 biome 决定（单引号、分号、尾逗号、2 空格缩进、行宽 100）。每次提交前先运行 `pnpm lint:fix`，再确认 `pnpm lint` 和 `pnpm type-check` 都通过。
- **架构测试**（`src/__tests__/simplificationArchitecture.test.ts`）：生产文件不超过 900 行，单个函数不超过 150 行。
- **测试**：用 vitest，测试文件放在源码旁的 `__tests__/` 目录。纯类型断言用 `expectTypeOf`，它们只在 `pnpm type-check` 时生效。
- **不新增运行时依赖**：schema 用已有的 `zod`，缓存用已有的 `lru-cache`，摘要用 Web Crypto。
- **7.x 兼容**（spec §4.7）：
  - 不新增 content part 类型，`ModelContent` 仍是 `ModelTextContent | ModelImageContent`；
  - 新字段全部可选；只有 `{ url }` 的旧图片在所有 schema 和代码路径中继续合法；
  - 不往 `initialize.features` 里加 key；协议 schema 只做向后兼容的放宽。
- **浏览器安全**：`src/images/` 下的模块会进入浏览器构建。不得 import Node 内置模块，源码（包括注释）里也不能出现 `node:` 字样，因为 `scripts/verify-entrypoints.mjs` 会扫描。
- **changelog**：每个用户可见的改动都在 `.changes/` 下加一个 JSON fragment，用 `pnpm changelog:check` 校验。
- **分支与提交**：分支 `feat/image-budget`（spec 已提交在这个分支上）；每个任务结束提交一次，使用 conventional commit 格式。
- **已核实的事实**（直接依赖，不要再猜）：
  - 1MB PNG 的 data URL 目前被 `TokenCounter.countTokens` 估为 954,409 tokens，耗时约 1.2 秒。
  - `@ai-sdk/openai` 3.0.112 默认走 Responses API；用户消息里图片的 detail 由该 part 的 `providerOptions.openai.imageDetail` 指定。
  - 很多 Session 测试用 `vi.mock('../../agent/Agent.js')` 把 Agent 换成只有 `streamChat` 和 `setModel` 的假对象。所以 Session 侧代码不得调用 Agent 的新方法，图片运行时由 `SessionRuntime` 持有。
  - 测试夹具：一张真实 1×1 PNG 的 base64 为 `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+KDnxWQAAAABJRU5ErkJggg==`，解码后 70 字节。
  - `TraceRecorder` 在 `capturePayloads` 为 false 时，会把事件数据替换成 `[redacted]` 摘要；它也没有给打开中的 span 追加属性的 API。因此图片投影记录为 turn span 内的一个事件，spec §6.7 说的"记录在 turn span 上"按这个方式实现。
  - `agentInitializationDataSchema.features` 目前是 strict，未知 key 会让握手失败。
  - `InProcessSessionExecutor.submit` 不捕获 `session.send` 抛出的错误；`AgentServer.failure()` 会把任何非 `AgentProtocolError` 的错误变成可重试的 `INTERNAL_ERROR` 500。

## 文件结构

新增（`src/images/`，浏览器安全）：

| 文件 | 职责 |
|---|---|
| `base64.ts` | base64 编解码、data URL 解析、不解码估算解码后长度 |
| `imageBytes.ts` | 按魔数识别 png/jpeg/gif/webp，读取宽高 |
| `ImageStore.ts` | `ImageStore` / `TenantImageStore` 端口、`blade-image:` 引用、SHA-256、`combineImageStores` |
| `InMemoryImageStore.ts` | 进程内、按字节 LRU、按租户隔离的 store |
| `ImagePolicy.ts` | `ImagePolicy` 类型、默认值、校验与解析 |
| `visionDefaults.ts` | 内置视觉能力表与 `resolveVisionCapability` |
| `estimateImageTokens.ts` | 三种 provider 估算公式与默认值 |
| `imageText.ts` | 图片描述、压缩用文本、占位文本 |
| `imageRefSchema.ts` | protocol、stream、durable 三处 schema 共用的可选字段 |
| `normalizeImages.ts` | 入口规范化与 `ImageRejection` |
| `imageBudget.ts` | 纯函数 `selectImages`：fresh 图片优先、历史图片稳定裁剪 |
| `prepareImagesForRequest.ts` | 请求投影：占位、解析引用、生成报告 |
| `imageErrors.ts` | `classifyImageLimitError` |
| `ImageRuntime.ts` | Session 级的入口与出口组合，绑定当前模型 |
| `__tests__/fixtures.ts` | 测试夹具：各格式的文件头、真实 1×1 PNG |

新增（`src/model/`）：`image.ts`（`ImageRef`、`ImageDetail`）、`vision.ts`（`VisionCapability` 等）。

修改：

| 文件 | 改动 |
|---|---|
| `model/message.ts`、`model/config.ts` | `image_url` 的类型改为 `ImageRef`；新增 `ModelConfig.vision`、`ModelServiceConfig.vision` |
| `session/types.ts` | 新增 `SessionOptions.images`、`SessionOptions.vision` |
| `errors/SessionInputError.ts`、`errors/index.ts` | 新增错误码 `SESSION_INPUT_IMAGE_REJECTED` 和 `details` 字段 |
| `agent/ModelManager.ts` | 解析视觉能力、计算输入窗口、记录运行期降级 |
| `agent/types.ts`、`agent/Agent.ts`、`session/SessionLifecycle.ts` | 透传 `vision`；绑定 `ImageRuntime` |
| `session/SessionRuntime.ts` | 创建 `ImageRuntime`，放进 Agent 依赖 |
| `session/SessionRequestCoordinator.ts` | 在 `send()` 入口做规范化 |
| `context/TokenCounter.ts`、`context/CompactionService.ts`、`agent/CompactionHandler.ts`、`agent/LoopHookBuilder.ts` | 图片按尺寸估算；压缩时把图片写成描述 |
| `services/messageUtils.ts`、`protocol/schemas.ts`、`session/streamSchema.ts`、`session/DurableRequestRecovery.ts` | 接受并拷贝 `ImageRef` 的字段；放宽 `features` |
| `server/SessionExecutor.ts` | 把 `SessionInputError` 映射为协议错误 |
| `agent/state/TurnState.ts`、`agent/state/LoopState.ts`、`agent/LoopRunner.ts`、`agent/loop/runTurn.ts` | 每轮请求前投影 |
| `agent/AgentEvent.ts`、`session/StreamBroadcaster.ts` | 内部事件 `image_projection`，恢复 reason `image_limit` |
| `agent/AgentLoop.ts` | 图片错误恢复与收紧模式 |
| `services/modelAdapter.ts` | 映射 `detail` 和 `mediaType` |
| `index.ts`、`core/index.ts` | 新增导出 |
| `docs/session.md`、`docs/en/session.md`、`docs/providers.md`、`docs/en/providers.md`、`docs/api-reference.md`、`docs/en/api-reference.md` | 文档 |

---

### Task 1: 图片与视觉能力契约

**Files:**
- Create: `src/model/image.ts`
- Create: `src/model/vision.ts`
- Create: `src/images/ImageStore.ts`（本任务只放类型）
- Create: `src/images/ImagePolicy.ts`（本任务只放类型）
- Modify: `src/model/message.ts`
- Modify: `src/model/config.ts`
- Modify: `src/session/types.ts`
- Modify: `src/index.ts`
- Test: `src/model/__tests__/imageContracts.test.ts`

**Interfaces:**
- Produces（后续所有任务依赖这些名字）：
  - `ImageDetail = 'auto' | 'low' | 'high'`
  - `ImageRef { url: string; detail?; mediaType?; width?; height?; byteLength?; alt? }`
  - `ModelImageContent { type: 'image_url'; image_url: ImageRef }`
  - `VisionCapability { images: boolean; toolResultImages: boolean; mediaTypes?: readonly string[]; maxImageBytes?: number; maxImagesPerRequest?: number; imageTokens?: 'openai' | 'anthropic' | 'gemini' | number }`
  - `VisionCapabilityOverride = Partial<VisionCapability>`
  - `VisionResolver = (model: { readonly provider: string; readonly model: string }) => VisionCapabilityOverride | undefined`
  - `ImageBytes { readonly bytes: Uint8Array; readonly mediaType: string }`、`ResolvedImage = ImageBytes | { readonly url: string }`
  - `ImageStore { handles(url): boolean; put(image: ImageBytes, signal?): Promise<ImageRef>; get(url, signal?): Promise<ResolvedImage | undefined>; delete?(url): Promise<void> }`
  - `TenantImageStore { forTenant(tenantId: string): ImageStore }`
  - `ImagePolicy { store?; maxImageBytes?; maxImagesPerInput?; historyTokens?; maxImagesPerRequest?; whenUnsupported?: 'reject' | 'omit'; remoteUrls? }`
  - `ModelConfig.vision?: VisionCapabilityOverride`、`ModelServiceConfig.vision?: VisionCapability`
  - `SessionOptions.images?: ImagePolicy`、`SessionOptions.vision?: VisionCapabilityOverride | VisionResolver`

- [ ] **Step 1: 写失败测试**

创建 `src/model/__tests__/imageContracts.test.ts`：

```ts
import { describe, expectTypeOf, it } from 'vitest';
import type {
  AgentOptions,
  ImageDetail,
  ImagePolicy,
  ImageRef,
  ImageStore,
  ModelConfig,
  ModelContent,
  ModelImageContent,
  ModelServiceConfig,
  SessionOptions,
  TenantImageStore,
  VisionCapability,
  VisionCapabilityOverride,
  VisionResolver,
} from '../../index.js';

describe('image contracts', () => {
  it('keeps image_url as the only image part and widens its payload to ImageRef', () => {
    expectTypeOf<ModelImageContent['image_url']>().toEqualTypeOf<ImageRef>();
    expectTypeOf<ModelContent['type']>().toEqualTypeOf<'text' | 'image_url'>();
    expectTypeOf<{ url: string }>().toMatchTypeOf<ImageRef>();
    expectTypeOf<ImageDetail>().toEqualTypeOf<'auto' | 'low' | 'high'>();
  });

  it('declares vision capability on models, sessions and service configs', () => {
    expectTypeOf<ModelConfig['vision']>().toEqualTypeOf<VisionCapabilityOverride | undefined>();
    expectTypeOf<ModelServiceConfig['vision']>().toEqualTypeOf<VisionCapability | undefined>();
    expectTypeOf<SessionOptions['vision']>().toEqualTypeOf<
      VisionCapabilityOverride | VisionResolver | undefined
    >();
    expectTypeOf<VisionCapability['imageTokens']>().toEqualTypeOf<
      'openai' | 'anthropic' | 'gemini' | number | undefined
    >();
  });

  it('declares the image policy and the store ports', () => {
    expectTypeOf<SessionOptions['images']>().toEqualTypeOf<ImagePolicy | undefined>();
    expectTypeOf<NonNullable<AgentOptions['advanced']>['images']>().toEqualTypeOf<
      ImagePolicy | undefined
    >();
    expectTypeOf<ImagePolicy['store']>().toEqualTypeOf<ImageStore | undefined>();
    expectTypeOf<ReturnType<TenantImageStore['forTenant']>>().toEqualTypeOf<ImageStore>();
    expectTypeOf<ReturnType<ImageStore['put']>>().toEqualTypeOf<Promise<ImageRef>>();
  });
});
```

- [ ] **Step 2: 确认类型检查失败**

Run: `pnpm type-check`
Expected: FAIL，报 `Module '"../../index.js"' has no exported member 'ImageRef'` 等错误。

- [ ] **Step 3: 新增契约文件**

创建 `src/model/image.ts`：

```ts
/** How much detail a provider should spend on an image. Only OpenAI reads it today. */
export type ImageDetail = 'auto' | 'low' | 'high';

/**
 * One model-visible image.
 *
 * `url` is a `data:` URL, an `http(s):` URL, or a reference that an
 * `ImageStore` resolves, for example `blade-image:sha256:<hex>`. Every other
 * field is optional metadata, so a bare `{ url }` is a valid reference.
 */
export interface ImageRef {
  url: string;
  detail?: ImageDetail;
  /** image/png, image/jpeg, image/gif or image/webp once the SDK has checked the bytes. */
  mediaType?: string;
  /** Pixel size read from the file header; budget estimates use it. */
  width?: number;
  height?: number;
  /** Decoded size in bytes. */
  byteLength?: number;
  /** Text used in place of the image when it cannot be sent to the model. */
  alt?: string;
}
```

创建 `src/model/vision.ts`：

```ts
/**
 * What the active model accepts as image input.
 *
 * Resolved per model from the built-in table, then `ModelConfig.vision`, then
 * `SessionOptions.vision`.
 */
export interface VisionCapability {
  /** The model accepts image input. */
  images: boolean;
  /**
   * Images may stay inside tool results. When false, requests move them into a
   * user message that follows the tool results.
   */
  toolResultImages: boolean;
  /** Accepted media types; png, jpeg, gif and webp when omitted. */
  mediaTypes?: readonly string[];
  /** Largest accepted image in bytes. */
  maxImageBytes?: number;
  /** Most images one request may carry. */
  maxImagesPerRequest?: number;
  /** Token estimate formula, or a fixed token count per image. */
  imageTokens?: 'openai' | 'anthropic' | 'gemini' | number;
}

export type VisionCapabilityOverride = Partial<VisionCapability>;

export type VisionResolver = (model: {
  readonly provider: string;
  readonly model: string;
}) => VisionCapabilityOverride | undefined;
```

创建 `src/images/ImageStore.ts`：

```ts
import type { ImageRef } from '../model/image.js';

export interface ImageBytes {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

/** Bytes of a stored image, or a URL the provider can fetch itself (for example a presigned URL). */
export type ResolvedImage = ImageBytes | { readonly url: string };

/**
 * Where image bytes live outside the transcript.
 *
 * When a Session has a store, inline images are written through `put()` and
 * only the returned reference is kept. `get()` runs when a request needs the
 * image again.
 */
export interface ImageStore {
  /** Whether this store resolves `url`. */
  handles(url: string): boolean;
  /** Persist one image and return its reference with complete metadata. */
  put(image: ImageBytes, signal?: AbortSignal): Promise<ImageRef>;
  /** Resolve a reference this store handles; undefined when the image is gone. */
  get(url: string, signal?: AbortSignal): Promise<ResolvedImage | undefined>;
  delete?(url: string): Promise<void>;
}

/** A store shared by tenants; each tenant sees only its own images. */
export interface TenantImageStore {
  forTenant(tenantId: string): ImageStore;
}
```

创建 `src/images/ImagePolicy.ts`：

```ts
import type { ImageStore } from './ImageStore.js';

/** How a Session admits images and budgets them in model requests. */
export interface ImagePolicy {
  /** Where image bytes live. Without one, images stay inline as data: URLs. */
  store?: ImageStore;
  /** Largest accepted image in bytes. Default 10 MiB, further capped by the model. */
  maxImageBytes?: number;
  /** Most images in one input. Default 20. */
  maxImagesPerInput?: number;
  /** Token allowance for images the model has already seen. Default min(16,000, a quarter of the input window). */
  historyTokens?: number;
  /** Most images in one request. Default: the model's limit, otherwise 50. */
  maxImagesPerRequest?: number;
  /** What `send()` does with images when the model cannot accept them. Default 'reject'. */
  whenUnsupported?: 'reject' | 'omit';
  /** Accept http(s) images from callers. Default true; the SDK never fetches them itself. */
  remoteUrls?: boolean;
}
```

- [ ] **Step 4: 把契约接到现有类型上**

`src/model/message.ts`：在文件顶部的 import 后加 `import type { ImageRef } from './image.js';`，把 `ModelImageContent` 改为：

```ts
export interface ModelImageContent {
  type: 'image_url';
  image_url: ImageRef;
}
```

`src/model/config.ts`：
- 顶部加入 `import type { VisionCapability, VisionCapabilityOverride } from './vision.js';`。
- 在 `ModelConfig` 的 `supportsThinking?: boolean;` 之后加：

```ts
  /** Overrides the built-in image capability row for this model. */
  vision?: VisionCapabilityOverride;
```

- 在 `ModelServiceConfig` 的 `retry?: Partial<ModelRetryConfig>;` 之后加：

```ts
  /** Image capability the SDK resolved for `model`; custom adapters may read it. */
  vision?: VisionCapability;
```

`src/session/types.ts`：
- 在 import 区加入 `import type { ImagePolicy } from '../images/ImagePolicy.js';` 和 `import type { VisionCapabilityOverride, VisionResolver } from '../model/vision.js';`。
- 在 `SessionOptions` 的 `tokenBudget?: TokenBudgetConfig;` 之后加：

```ts
  /** Image admission, storage and request budget. */
  images?: ImagePolicy;
  /**
   * Overrides what the model accepts as image input. An object applies to the
   * Session's model whatever it is switched to; a function is asked per model.
   */
  vision?: VisionCapabilityOverride | VisionResolver;
```

`src/index.ts`：在 `export * from './model/config.js';` 附近加：

```ts
export type * from './model/image.js';
export type * from './model/vision.js';
export type { ImagePolicy } from './images/ImagePolicy.js';
export type {
  ImageBytes,
  ImageStore,
  ResolvedImage,
  TenantImageStore,
} from './images/ImageStore.js';
```

- [ ] **Step 5: 确认通过**

Run: `pnpm lint:fix && pnpm type-check && pnpm vitest run src/model/__tests__/imageContracts.test.ts src/__tests__/rootExports.test.ts`
Expected: 类型检查通过，测试全部通过。

- [ ] **Step 6: 提交**

```bash
git add src/model/image.ts src/model/vision.ts src/images/ImageStore.ts src/images/ImagePolicy.ts src/model/message.ts src/model/config.ts src/session/types.ts src/index.ts src/model/__tests__/imageContracts.test.ts
git commit -m "feat(images): add ImageRef, VisionCapability and ImagePolicy contracts"
```

---

### Task 2: base64 工具与图片文件头解析

**Files:**
- Create: `src/images/base64.ts`
- Create: `src/images/imageBytes.ts`
- Create: `src/images/__tests__/fixtures.ts`
- Test: `src/images/__tests__/base64.test.ts`
- Test: `src/images/__tests__/imageBytes.test.ts`

**Interfaces:**
- Produces：
  - `parseBase64DataUrl(url: string): { mediaType: string; base64: string } | undefined`（mediaType 小写，缺省为空串）
  - `base64DecodedLength(base64: string): number`
  - `base64ToBytes(base64: string): Uint8Array`
  - `base64PrefixToBytes(base64: string, maxBytes: number): Uint8Array`
  - `bytesToBase64(bytes: Uint8Array): string`
  - `toDataUrl(mediaType: string, bytes: Uint8Array): string`
  - `IMAGE_MEDIA_TYPES`（`readonly ['image/png', 'image/jpeg', 'image/gif', 'image/webp']`）
  - `ImageMediaType`
  - `ImageFacts { mediaType: ImageMediaType; byteLength: number; width?: number; height?: number }`
  - `sniffImageMediaType(bytes: Uint8Array): ImageMediaType | undefined`
  - `inspectImageBytes(bytes: Uint8Array): ImageFacts | undefined`
  - 测试夹具（`src/images/__tests__/fixtures.ts`）：`ONE_PIXEL_PNG_BASE64`、`ONE_PIXEL_PNG_DATA_URL`、`pngBytes(w, h, totalBytes?)`、`jpegBytes(w, h, { progressive?, exifBytes? })`、`gifBytes(w, h)`、`webpLossyBytes(w, h)`、`webpLosslessBytes(w, h)`、`webpExtendedBytes(w, h)`、`dataUrl(mediaType, bytes)`

- [ ] **Step 1: 写测试夹具**

创建 `src/images/__tests__/fixtures.ts`：

```ts
import { bytesToBase64 } from '../base64.js';

/** A real 1×1 RGBA PNG; 70 bytes once decoded. */
export const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+KDnxWQAAAABJRU5ErkJggg==';
export const ONE_PIXEL_PNG_DATA_URL = `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`;

const u16be = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const u16le = (value: number) => [value & 0xff, (value >> 8) & 0xff];
const u24le = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
const u32be = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const u32le = (value: number) => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 24) & 0xff,
];
const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

/** PNG signature and IHDR, zero-padded to `totalBytes`. Enough for sniffing and sizing only. */
export function pngBytes(width: number, height: number, totalBytes = 64): Uint8Array {
  const header = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32be(13),
    ...ascii('IHDR'),
    ...u32be(width),
    ...u32be(height),
    8, 6, 0, 0, 0,
  ];
  const bytes = new Uint8Array(Math.max(totalBytes, header.length));
  bytes.set(header);
  return bytes;
}

export function jpegBytes(
  width: number,
  height: number,
  options: { progressive?: boolean; exifBytes?: number } = {},
): Uint8Array {
  const exif = options.exifBytes ?? 0;
  const app1 = exif > 0 ? [0xff, 0xe1, ...u16be(exif + 2), ...new Array<number>(exif).fill(0)] : [];
  const sof = [
    0xff,
    options.progressive ? 0xc2 : 0xc0,
    ...u16be(17),
    8,
    ...u16be(height),
    ...u16be(width),
    3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1,
  ];
  return new Uint8Array([0xff, 0xd8, ...app1, ...sof, 0xff, 0xd9]);
}

export function gifBytes(width: number, height: number): Uint8Array {
  return new Uint8Array([...ascii('GIF89a'), ...u16le(width), ...u16le(height), 0, 0, 0]);
}

function riff(chunk: string, data: number[]): Uint8Array {
  const payload = [...ascii('WEBP'), ...ascii(chunk), ...u32le(data.length), ...data];
  return new Uint8Array([...ascii('RIFF'), ...u32le(payload.length), ...payload]);
}

export function webpLossyBytes(width: number, height: number): Uint8Array {
  return riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height), 0, 0]);
}

export function webpLosslessBytes(width: number, height: number): Uint8Array {
  return riff('VP8L', [0x2f, ...u32le((width - 1) | ((height - 1) << 14)), 0, 0, 0, 0, 0]);
}

export function webpExtendedBytes(width: number, height: number): Uint8Array {
  return riff('VP8X', [0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1), 0, 0]);
}

export function dataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${bytesToBase64(bytes)}`;
}
```

如果 `pnpm lint:fix` 把 `pngBytes` 里的数字字面量拆成一行一个，可以接受。

- [ ] **Step 2: 写失败测试**

创建 `src/images/__tests__/base64.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  base64DecodedLength,
  base64PrefixToBytes,
  base64ToBytes,
  bytesToBase64,
  parseBase64DataUrl,
  toDataUrl,
} from '../base64.js';

describe('base64 helpers', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(toDataUrl('image/png', new Uint8Array([0, 127, 128, 255]))).toBe(
      'data:image/png;base64,AH+A/w==',
    );
  });

  it('works without Buffer', () => {
    vi.stubGlobal('Buffer', undefined);
    try {
      expect(bytesToBase64(new Uint8Array([0, 127, 128, 255]))).toBe('AH+A/w==');
      expect(base64ToBytes('AH+A/w==')).toEqual(new Uint8Array([0, 127, 128, 255]));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('parses base64 data URLs and ignores everything else', () => {
    expect(parseBase64DataUrl('data:image/PNG;base64,AAAA')).toEqual({
      mediaType: 'image/png',
      base64: 'AAAA',
    });
    expect(parseBase64DataUrl('data:;base64,AAAA')).toEqual({ mediaType: '', base64: 'AAAA' });
    expect(parseBase64DataUrl('data:image/png;charset=utf-8;base64,AAAA')).toEqual({
      mediaType: 'image/png',
      base64: 'AAAA',
    });
    expect(parseBase64DataUrl('data:image/svg+xml,<svg/>')).toBeUndefined();
    expect(parseBase64DataUrl('https://example.test/a.png')).toBeUndefined();
  });

  it('computes the decoded length without decoding', () => {
    expect(base64DecodedLength('')).toBe(0);
    expect(base64DecodedLength('AAAA')).toBe(3);
    expect(base64DecodedLength('AAA=')).toBe(2);
    expect(base64DecodedLength('AA==')).toBe(1);
  });

  it('decodes only a prefix', () => {
    const bytes = new Uint8Array(1000).map((_, index) => index % 256);
    expect(base64PrefixToBytes(bytesToBase64(bytes), 10)).toEqual(bytes.subarray(0, 12));
  });
});
```

创建 `src/images/__tests__/imageBytes.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { base64ToBytes } from '../base64.js';
import { inspectImageBytes, sniffImageMediaType } from '../imageBytes.js';
import {
  gifBytes,
  jpegBytes,
  ONE_PIXEL_PNG_BASE64,
  pngBytes,
  webpExtendedBytes,
  webpLosslessBytes,
  webpLossyBytes,
} from './fixtures.js';

const encoder = new TextEncoder();

describe('inspectImageBytes', () => {
  it.each([
    ['png', pngBytes(1280, 720), 'image/png', 1280, 720],
    ['baseline jpeg', jpegBytes(640, 480), 'image/jpeg', 640, 480],
    ['progressive jpeg', jpegBytes(800, 600, { progressive: true }), 'image/jpeg', 800, 600],
    ['jpeg with EXIF before SOF', jpegBytes(1024, 768, { exifBytes: 4096 }), 'image/jpeg', 1024, 768],
    ['gif', gifBytes(320, 200), 'image/gif', 320, 200],
    ['lossy webp', webpLossyBytes(1920, 1080), 'image/webp', 1920, 1080],
    ['lossless webp', webpLosslessBytes(256, 128), 'image/webp', 256, 128],
    ['extended webp', webpExtendedBytes(4000, 3000), 'image/webp', 4000, 3000],
  ] as const)('reads %s headers', (_name, bytes, mediaType, width, height) => {
    expect(inspectImageBytes(bytes)).toEqual({
      mediaType,
      width,
      height,
      byteLength: bytes.byteLength,
    });
  });

  it('reads a real PNG', () => {
    expect(inspectImageBytes(base64ToBytes(ONE_PIXEL_PNG_BASE64))).toEqual({
      mediaType: 'image/png',
      width: 1,
      height: 1,
      byteLength: 70,
    });
  });

  it('refuses SVG and unknown bytes', () => {
    expect(sniffImageMediaType(encoder.encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
      undefined,
    );
    expect(inspectImageBytes(encoder.encode('<?xml version="1.0"?><svg/>'))).toBeUndefined();
    expect(inspectImageBytes(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it('keeps the media type when a truncated header hides the size', () => {
    expect(inspectImageBytes(pngBytes(10, 10).subarray(0, 12))).toEqual({
      mediaType: 'image/png',
      byteLength: 12,
    });
    expect(inspectImageBytes(jpegBytes(10, 10, { exifBytes: 64 }).subarray(0, 40))).toEqual({
      mediaType: 'image/jpeg',
      byteLength: 40,
    });
    expect(inspectImageBytes(webpLossyBytes(10, 10).subarray(0, 16))).toEqual({
      mediaType: 'image/webp',
      byteLength: 16,
    });
  });

  it('stops at a corrupt JPEG segment instead of reading past it', () => {
    const bytes = jpegBytes(10, 10, { exifBytes: 8 });
    bytes[4] = 0x00;
    bytes[5] = 0x01;
    expect(inspectImageBytes(bytes)).toEqual({ mediaType: 'image/jpeg', byteLength: 35 });
  });
});
```

- [ ] **Step 3: 确认测试失败**

Run: `pnpm vitest run src/images/__tests__/base64.test.ts src/images/__tests__/imageBytes.test.ts`
Expected: FAIL，报 `Failed to load url ../base64.js`（模块不存在）。

- [ ] **Step 4: 实现**

创建 `src/images/base64.ts`：

```ts
const BASE64_DATA_URL_PREFIX = /^data:([^;,]*)((?:;[^;,]*)*?);base64,/i;
const HEADER_SCAN_CHARS = 256;

export interface Base64DataUrl {
  /** Declared media type, lowercased; empty when the URL omits it. */
  readonly mediaType: string;
  readonly base64: string;
}

/** Split a base64 `data:` URL. Other URLs, including non-base64 data URLs, return undefined. */
export function parseBase64DataUrl(url: string): Base64DataUrl | undefined {
  const match = BASE64_DATA_URL_PREFIX.exec(url.slice(0, HEADER_SCAN_CHARS));
  if (!match) {
    return undefined;
  }
  return { mediaType: match[1].trim().toLowerCase(), base64: url.slice(match[0].length) };
}

/** Bytes a base64 payload decodes to, computed without decoding it. */
export function base64DecodedLength(base64: string): number {
  if (base64.length === 0) {
    return 0;
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buffer = Buffer.from(base64, 'base64');
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Decode at most `maxBytes` from the start of a base64 payload. */
export function base64PrefixToBytes(base64: string, maxBytes: number): Uint8Array {
  return base64ToBytes(base64.slice(0, Math.ceil(maxBytes / 3) * 4));
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function toDataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${bytesToBase64(bytes)}`;
}
```

创建 `src/images/imageBytes.ts`：

```ts
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export interface ImageFacts {
  readonly mediaType: ImageMediaType;
  readonly byteLength: number;
  readonly width?: number;
  readonly height?: number;
}

interface ImageSize {
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return (
    bytes.length >= offset + prefix.length &&
    prefix.every((value, index) => bytes[offset + index] === value)
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return bytes.length < offset + length
    ? ''
    : String.fromCharCode(...bytes.subarray(offset, offset + length));
}

const uint16be = (bytes: Uint8Array, offset: number) => (bytes[offset] << 8) | bytes[offset + 1];
const uint16le = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8);
const uint24le = (bytes: Uint8Array, offset: number) =>
  bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
const uint32be = (bytes: Uint8Array, offset: number) =>
  ((bytes[offset] << 24) >>> 0) +
  ((bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]);

function size(width: number, height: number): ImageSize | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** Identify a raster image by its magic bytes. SVG and everything else return undefined. */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  const gif = ascii(bytes, 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return undefined;
}

function pngSize(bytes: Uint8Array): ImageSize | undefined {
  return bytes.length >= 24 && ascii(bytes, 12, 4) === 'IHDR'
    ? size(uint32be(bytes, 16), uint32be(bytes, 20))
    : undefined;
}

function gifSize(bytes: Uint8Array): ImageSize | undefined {
  return bytes.length >= 10 ? size(uint16le(bytes, 6), uint16le(bytes, 8)) : undefined;
}

function jpegSize(bytes: Uint8Array): ImageSize | undefined {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = uint16be(bytes, offset + 2);
    if (length < 2) return undefined;
    if (JPEG_SOF_MARKERS.has(marker)) {
      return offset + 9 <= bytes.length
        ? size(uint16be(bytes, offset + 7), uint16be(bytes, offset + 5))
        : undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 30) return undefined;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8 ') {
    return startsWith(bytes, [0x9d, 0x01, 0x2a], 23)
      ? size(uint16le(bytes, 26) & 0x3fff, uint16le(bytes, 28) & 0x3fff)
      : undefined;
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return undefined;
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8X') {
    return size(uint24le(bytes, 24) + 1, uint24le(bytes, 27) + 1);
  }
  return undefined;
}

function readImageSize(bytes: Uint8Array, mediaType: ImageMediaType): ImageSize | undefined {
  switch (mediaType) {
    case 'image/png':
      return pngSize(bytes);
    case 'image/jpeg':
      return jpegSize(bytes);
    case 'image/gif':
      return gifSize(bytes);
    case 'image/webp':
      return webpSize(bytes);
  }
}

/**
 * Media type, pixel size and byte length of a png, jpeg, gif or webp image.
 * Returns undefined for anything else. A truncated header keeps the media type
 * and drops the size.
 */
export function inspectImageBytes(bytes: Uint8Array): ImageFacts | undefined {
  const mediaType = sniffImageMediaType(bytes);
  if (!mediaType) return undefined;
  return { mediaType, byteLength: bytes.byteLength, ...readImageSize(bytes, mediaType) };
}
```

- [ ] **Step 5: 确认通过**

Run: `pnpm vitest run src/images/__tests__/base64.test.ts src/images/__tests__/imageBytes.test.ts`
Expected: 全部通过（imageBytes 共 13 个用例）。

- [ ] **Step 6: 提交**

```bash
pnpm lint:fix && pnpm type-check
git add src/images/base64.ts src/images/imageBytes.ts src/images/__tests__/fixtures.ts src/images/__tests__/base64.test.ts src/images/__tests__/imageBytes.test.ts
git commit -m "feat(images): read image media type and size from file headers"
```

---

### Task 3: ImageStore 运行时、InMemoryImageStore 与导出

**Files:**
- Modify: `src/images/ImageStore.ts`
- Create: `src/images/InMemoryImageStore.ts`
- Modify: `src/index.ts`
- Modify: `src/core/index.ts`
- Test: `src/images/__tests__/InMemoryImageStore.test.ts`
- Test: `src/images/__tests__/browserSafety.test.ts`
- Modify (test): `src/__tests__/rootExports.test.ts`、`src/__tests__/packageEntrypoints.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `ImageStore`、`ImageBytes`、`ResolvedImage`、`TenantImageStore`；Task 2 的 `inspectImageBytes`。
- Produces：
  - `BLADE_IMAGE_URL_PREFIX = 'blade-image:sha256:'`
  - `bladeImageUrl(sha256: string): string`
  - `parseBladeImageUrl(url: string): string | undefined`（只接受 64 位小写十六进制）
  - `sha256Hex(bytes: Uint8Array): Promise<string>`
  - `combineImageStores(primary: ImageStore, ...others: ImageStore[]): ImageStore`
  - `class InMemoryImageStore implements ImageStore, TenantImageStore`，构造参数 `{ maxBytes?: number }`，默认 256 MiB
  - 类型 `InMemoryImageStoreOptions`

- [ ] **Step 1: 写失败测试**

创建 `src/images/__tests__/InMemoryImageStore.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { combineImageStores, type ImageStore, sha256Hex } from '../ImageStore.js';
import { InMemoryImageStore } from '../InMemoryImageStore.js';
import { pngBytes } from './fixtures.js';

describe('InMemoryImageStore', () => {
  it('stores images by content and returns complete metadata', async () => {
    const store = new InMemoryImageStore();
    const bytes = pngBytes(1280, 720, 512);
    const ref = await store.put({ bytes, mediaType: 'image/png' });

    expect(ref).toEqual({
      url: expect.stringMatching(/^blade-image:sha256:[0-9a-f]{64}$/),
      mediaType: 'image/png',
      width: 1280,
      height: 720,
      byteLength: 512,
    });
    expect(store.handles(ref.url)).toBe(true);
    expect(await store.get(ref.url)).toEqual({ bytes, mediaType: 'image/png' });
    expect(await store.put({ bytes: bytes.slice(), mediaType: 'image/png' })).toEqual(ref);
  });

  it('isolates tenants', async () => {
    const store = new InMemoryImageStore();
    const ref = await store.forTenant('tenant-a').put({ bytes: pngBytes(2, 2), mediaType: 'image/png' });

    expect(await store.forTenant('tenant-a').get(ref.url)).toBeDefined();
    expect(await store.forTenant('tenant-b').get(ref.url)).toBeUndefined();
    expect(await store.get(ref.url)).toBeUndefined();
  });

  it('evicts the least recently used images past maxBytes', async () => {
    const store = new InMemoryImageStore({ maxBytes: 1_000 });
    const first = await store.put({ bytes: pngBytes(1, 1, 400), mediaType: 'image/png' });
    const second = await store.put({ bytes: pngBytes(2, 2, 400), mediaType: 'image/png' });
    await store.get(first.url);
    await store.put({ bytes: pngBytes(3, 3, 400), mediaType: 'image/png' });

    expect(await store.get(first.url)).toBeDefined();
    expect(await store.get(second.url)).toBeUndefined();
  });

  it('refuses non-raster bytes and images larger than the store', async () => {
    const store = new InMemoryImageStore({ maxBytes: 100 });
    await expect(
      store.put({ bytes: new TextEncoder().encode('<svg/>'), mediaType: 'image/svg+xml' }),
    ).rejects.toThrow(TypeError);
    await expect(store.put({ bytes: pngBytes(1, 1, 200), mediaType: 'image/png' })).rejects.toThrow(
      RangeError,
    );
    expect(() => new InMemoryImageStore({ maxBytes: 0 })).toThrow(RangeError);
  });

  it('ignores references it does not own', async () => {
    const store = new InMemoryImageStore();
    expect(store.handles('lark-image:img_v3')).toBe(false);
    expect(store.handles('blade-image:sha256:abc')).toBe(false);
    expect(await store.get('https://example.test/a.png')).toBeUndefined();
  });
});

describe('combineImageStores', () => {
  it('writes to the primary store and reads from whichever store owns the reference', async () => {
    const primary = new InMemoryImageStore();
    const lark: ImageStore = {
      handles: (url) => url.startsWith('lark-image:'),
      put: async () => {
        throw new Error('read-only');
      },
      get: async (url) =>
        url === 'lark-image:img_1' ? { url: 'https://cdn.example.test/img_1.png' } : undefined,
    };
    const store = combineImageStores(primary, lark);
    const ref = await store.put({ bytes: pngBytes(4, 4), mediaType: 'image/png' });

    expect(await store.get(ref.url)).toMatchObject({ mediaType: 'image/png' });
    expect(store.handles('lark-image:img_1')).toBe(true);
    expect(await store.get('lark-image:img_1')).toEqual({
      url: 'https://cdn.example.test/img_1.png',
    });
    expect(store.handles('s3://bucket/key')).toBe(false);
    expect(await store.get('s3://bucket/key')).toBeUndefined();
    await store.delete?.(ref.url);
    expect(await store.get(ref.url)).toBeUndefined();
  });

  it('hashes with SHA-256', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
```

创建 `src/images/__tests__/browserSafety.test.ts`：

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('images module', () => {
  it('stays browser-safe', () => {
    for (const file of readdirSync('src/images').filter((name) => name.endsWith('.ts'))) {
      expect(readFileSync(join('src/images', file), 'utf8'), file).not.toMatch(/node:/);
    }
  });
});
```

在 `src/__tests__/rootExports.test.ts` 的 `exports shared primitives at root...` 用例末尾（`expect(projectDurableSession([]).status).toBe('empty');` 之后）加：

```ts
    expect(root.InMemoryImageStore).toBeTypeOf('function');
    expect(root.combineImageStores).toBeTypeOf('function');
```

在 `src/__tests__/packageEntrypoints.test.ts` 的 `throws clear errors from browser runtime stubs` 用例里，`expect(browser.AgentClient).toBeTypeOf('function');` 之后加：

```ts
    expect(browser.InMemoryImageStore).toBeTypeOf('function');
    expect(browser.combineImageStores).toBeTypeOf('function');
```

- [ ] **Step 2: 确认测试失败**

Run: `pnpm vitest run src/images/__tests__/InMemoryImageStore.test.ts src/__tests__/rootExports.test.ts src/__tests__/packageEntrypoints.test.ts`
Expected: FAIL：`InMemoryImageStore.js` 不存在；`root.InMemoryImageStore` 是 undefined。

- [ ] **Step 3: 实现**

在 `src/images/ImageStore.ts` 末尾追加：

```ts
/** Prefix of references written by the built-in content-addressed stores. */
export const BLADE_IMAGE_URL_PREFIX = 'blade-image:sha256:';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export function bladeImageUrl(sha256: string): string {
  return `${BLADE_IMAGE_URL_PREFIX}${sha256}`;
}

/** The SHA-256 digest inside a built-in store reference, or undefined for any other URL. */
export function parseBladeImageUrl(url: string): string | undefined {
  if (!url.startsWith(BLADE_IMAGE_URL_PREFIX)) return undefined;
  const digest = url.slice(BLADE_IMAGE_URL_PREFIX.length);
  return DIGEST_PATTERN.test(digest) ? digest : undefined;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}

/**
 * Join stores: `put` writes to `primary`; `handles`, `get` and `delete` go to
 * the first store that handles the reference. Applications plug their own
 * reference schemes (IM file keys, object storage) in this way.
 */
export function combineImageStores(primary: ImageStore, ...others: ImageStore[]): ImageStore {
  const stores = [primary, ...others];
  const owner = (url: string) => stores.find((store) => store.handles(url));
  return {
    handles: (url) => owner(url) !== undefined,
    put: (image, signal) => primary.put(image, signal),
    get: async (url, signal) => owner(url)?.get(url, signal),
    delete: async (url) => {
      await owner(url)?.delete?.(url);
    },
  };
}
```

创建 `src/images/InMemoryImageStore.ts`：

```ts
import { LRUCache } from 'lru-cache';
import type { ImageRef } from '../model/image.js';
import { inspectImageBytes } from './imageBytes.js';
import {
  bladeImageUrl,
  type ImageBytes,
  type ImageStore,
  parseBladeImageUrl,
  type ResolvedImage,
  sha256Hex,
  type TenantImageStore,
} from './ImageStore.js';

export interface InMemoryImageStoreOptions {
  /** Bytes held across all tenants before the least recently used images go. Default 256 MiB. */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_TENANT = '';

interface StoredImage {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

class InMemoryImageBucket implements ImageStore {
  constructor(
    private readonly images: LRUCache<string, StoredImage>,
    private readonly maxBytes: number,
    private readonly tenantId: string,
  ) {}

  handles(url: string): boolean {
    return parseBladeImageUrl(url) !== undefined;
  }

  async put(image: ImageBytes, signal?: AbortSignal): Promise<ImageRef> {
    signal?.throwIfAborted();
    const facts = inspectImageBytes(image.bytes);
    if (!facts) {
      throw new TypeError('InMemoryImageStore accepts only png, jpeg, gif and webp images');
    }
    if (facts.byteLength > this.maxBytes) {
      throw new RangeError(
        `An image of ${facts.byteLength} bytes exceeds the store limit of ${this.maxBytes} bytes`,
      );
    }
    const digest = await sha256Hex(image.bytes);
    const key = this.key(digest);
    if (this.images.get(key) === undefined) {
      this.images.set(key, { bytes: image.bytes.slice(), mediaType: facts.mediaType });
    }
    return {
      url: bladeImageUrl(digest),
      mediaType: facts.mediaType,
      byteLength: facts.byteLength,
      ...(facts.width !== undefined && facts.height !== undefined
        ? { width: facts.width, height: facts.height }
        : {}),
    };
  }

  async get(url: string): Promise<ResolvedImage | undefined> {
    const digest = parseBladeImageUrl(url);
    const image = digest ? this.images.get(this.key(digest)) : undefined;
    return image ? { bytes: image.bytes, mediaType: image.mediaType } : undefined;
  }

  async delete(url: string): Promise<void> {
    const digest = parseBladeImageUrl(url);
    if (digest) this.images.delete(this.key(digest));
  }

  private key(digest: string): string {
    return `${this.tenantId}\u0000${digest}`;
  }
}

/**
 * Process-local image store. Images live as long as the process; once
 * `maxBytes` is reached the least recently used ones are dropped, and a dropped
 * reference becomes an "unavailable" placeholder in later requests.
 */
export class InMemoryImageStore implements ImageStore, TenantImageStore {
  private readonly images: LRUCache<string, StoredImage>;
  private readonly maxBytes: number;
  private readonly defaultBucket: InMemoryImageBucket;

  constructor(options: InMemoryImageStoreOptions = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError('maxBytes must be a positive safe integer');
    }
    this.maxBytes = maxBytes;
    this.images = new LRUCache<string, StoredImage>({
      maxSize: maxBytes,
      sizeCalculation: (image) => Math.max(1, image.bytes.byteLength),
    });
    this.defaultBucket = new InMemoryImageBucket(this.images, maxBytes, DEFAULT_TENANT);
  }

  forTenant(tenantId: string): ImageStore {
    return new InMemoryImageBucket(this.images, this.maxBytes, tenantId);
  }

  handles(url: string): boolean {
    return this.defaultBucket.handles(url);
  }

  put(image: ImageBytes, signal?: AbortSignal): Promise<ImageRef> {
    return this.defaultBucket.put(image, signal);
  }

  get(url: string): Promise<ResolvedImage | undefined> {
    return this.defaultBucket.get(url);
  }

  delete(url: string): Promise<void> {
    return this.defaultBucket.delete(url);
  }
}
```

`src/index.ts`：在 Task 1 加的 `ImageStore.js` 类型导出旁边追加值导出：

```ts
export { combineImageStores } from './images/ImageStore.js';
export {
  InMemoryImageStore,
  type InMemoryImageStoreOptions,
} from './images/InMemoryImageStore.js';
```

`src/core/index.ts`：在 `export { definePlugin } ...` 之前加：

```ts
export { combineImageStores } from '../images/ImageStore.js';
export { InMemoryImageStore } from '../images/InMemoryImageStore.js';
```

- [ ] **Step 4: 确认通过**

Run: `pnpm vitest run src/images/__tests__ src/__tests__/rootExports.test.ts src/__tests__/packageEntrypoints.test.ts`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
pnpm lint:fix && pnpm type-check
git add src/images src/index.ts src/core/index.ts src/__tests__/rootExports.test.ts src/__tests__/packageEntrypoints.test.ts
git commit -m "feat(images): add the content-addressed in-memory image store"
```

---
### Task 4: 视觉能力默认表、解析与 ModelManager

**Files:**
- Create: `src/images/visionDefaults.ts`
- Modify: `src/agent/ModelManager.ts`
- Modify: `src/agent/types.ts`（`AgentRuntimeOptions.vision`）
- Modify: `src/agent/Agent.ts`（把 `vision` 交给 ModelManager）
- Modify: `src/session/SessionLifecycle.ts`（透传 `SessionOptions.vision`）
- Test: `src/images/__tests__/visionDefaults.test.ts`
- Modify (test): `src/agent/__tests__/ModelManager.setModel.test.ts`、`src/session/__tests__/SessionModelConfig.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `VisionCapability`、`VisionCapabilityOverride`、`VisionResolver`、`ModelConfig.vision`、`ModelServiceConfig.vision`、`SessionOptions.vision`。
- Produces：
  - `builtinVisionCapability(provider: string, model: string): VisionCapability`
  - `resolveVisionCapability(input: { provider: string; model: string; modelOverride?: VisionCapabilityOverride; sessionOverride?: VisionCapabilityOverride | VisionResolver; imagesUnsupported?: boolean }): VisionCapability`（非法数值抛 `ConfigError`）
  - `DEFAULT_VISION_CAPABILITY: VisionCapability`（`{ images: true, toolResultImages: false, imageTokens: 1600 }`）
  - `ModelManager` 构造函数第 8 个参数 `visionOverride?: VisionCapabilityOverride | VisionResolver`
  - `ModelManager.getVision(): VisionCapability | undefined`
  - `ModelManager.getInputWindowTokens(): number | undefined`
  - `ModelManager.markImagesUnsupported(): void`
  - `AgentRuntimeOptions.vision?: VisionCapabilityOverride | VisionResolver`

- [ ] **Step 1: 写失败测试**

创建 `src/images/__tests__/visionDefaults.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { ConfigError } from '../../errors/ConfigError.js';
import type { VisionCapability } from '../../model/vision.js';
import { builtinVisionCapability, resolveVisionCapability } from '../visionDefaults.js';

const MIB = 1024 * 1024;
const OPENAI: VisionCapability = {
  images: true,
  toolResultImages: true,
  imageTokens: 'openai',
  maxImageBytes: 20 * MIB,
};
const NONE: VisionCapability = { images: false, toolResultImages: false };
const PASS_THROUGH: VisionCapability = { images: true, toolResultImages: false, imageTokens: 1600 };

describe('builtinVisionCapability', () => {
  it.each([
    [
      'anthropic',
      'claude-sonnet-4-5',
      {
        images: true,
        toolResultImages: true,
        imageTokens: 'anthropic',
        maxImageBytes: 5 * MIB,
        maxImagesPerRequest: 100,
      },
    ],
    ['anthropic', 'claude-2.1', NONE],
    ['openai', 'gpt-5', OPENAI],
    ['openai', 'gpt-4o-mini', OPENAI],
    ['openai', 'gpt-4', NONE],
    ['openai', 'gpt-4-0125-preview', NONE],
    ['openai', 'o3-mini', NONE],
    ['openai', 'gpt-3.5-turbo', NONE],
    ['azure-openai', 'my-gpt4o-deployment', { images: true, toolResultImages: false, imageTokens: 'openai' }],
    ['gemini', 'gemini-2.5-pro', { images: true, toolResultImages: true, imageTokens: 'gemini' }],
    ['deepseek', 'deepseek-chat', PASS_THROUGH],
    ['deepseek', 'deepseek-v4-flash', PASS_THROUGH],
    ['deepseek', 'deepseek-v4-pro', NONE],
    ['deepseek', 'deepseek-r1', NONE],
    ['openai-compatible', 'qwen-vl-max', PASS_THROUGH],
    ['openai-compatible', 'qwq-32b', NONE],
    ['custom-wire-api', 'custom-model', PASS_THROUGH],
  ] as const)('%s %s', (provider, model, expected) => {
    expect(builtinVisionCapability(provider, model)).toEqual(expected);
  });
});

describe('resolveVisionCapability', () => {
  it('layers the model config, the session override and a runtime downgrade over the table', () => {
    expect(
      resolveVisionCapability({
        provider: 'openai-compatible',
        model: 'internal-vl',
        modelOverride: { toolResultImages: true, maxImagesPerRequest: 4 },
        sessionOverride: { maxImagesPerRequest: 1 },
      }),
    ).toEqual({ images: true, toolResultImages: true, imageTokens: 1600, maxImagesPerRequest: 1 });
    expect(
      resolveVisionCapability({
        provider: 'anthropic',
        model: 'claude-opus-4-1',
        imagesUnsupported: true,
      }).images,
    ).toBe(false);
  });

  it('asks a resolver per model and falls back to the table when it returns undefined', () => {
    const resolver = vi.fn(({ model }: { provider: string; model: string }) =>
      model === 'text-only' ? { images: false } : undefined,
    );
    expect(
      resolveVisionCapability({ provider: 'custom', model: 'text-only', sessionOverride: resolver })
        .images,
    ).toBe(false);
    expect(
      resolveVisionCapability({ provider: 'custom', model: 'other', sessionOverride: resolver }).images,
    ).toBe(true);
    expect(resolver).toHaveBeenCalledWith({ provider: 'custom', model: 'other' });
  });

  it('rejects invalid numeric overrides', () => {
    expect(() =>
      resolveVisionCapability({
        provider: 'openai',
        model: 'gpt-5',
        sessionOverride: { maxImagesPerRequest: 0 },
      }),
    ).toThrow(ConfigError);
    expect(() =>
      resolveVisionCapability({
        provider: 'openai',
        model: 'gpt-5',
        modelOverride: { imageTokens: -1 },
      }),
    ).toThrow(ConfigError);
  });
});
```

在 `src/agent/__tests__/ModelManager.setModel.test.ts` 的 `describe('ModelManager.setModel', ...)` 末尾追加：

```ts
  it('resolves vision for the active model and passes it to the service config', async () => {
    const config: BladeConfig = {
      models: [
        createModelConfig({
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          maxOutputTokens: 8000,
        }),
      ],
      currentModelId: 'default',
    };
    const manager = new ModelManager(config);
    const [model] = config.models;
    if (!model) throw new Error('Expected a model config');

    await manager.applyModelConfig(model, 'init');

    expect(manager.getVision()).toMatchObject({
      images: true,
      toolResultImages: true,
      imageTokens: 'anthropic',
    });
    expect(mockCreateModelServiceAsync.mock.calls.at(-1)?.[0].vision).toEqual(manager.getVision());
    expect(manager.getInputWindowTokens()).toBe(128000 - 8000);
  });

  it('applies the session override and remembers a runtime downgrade per model', async () => {
    const config: BladeConfig = { models: [createModelConfig()], currentModelId: 'default' };
    const manager = new ModelManager(
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      ({ model }) => (model === 'gpt-4o-mini' ? { maxImagesPerRequest: 2 } : undefined),
    );
    const [model] = config.models;
    if (!model) throw new Error('Expected a model config');

    await manager.applyModelConfig(model, 'init');
    expect(manager.getVision()).toMatchObject({ images: true, maxImagesPerRequest: 2 });

    manager.markImagesUnsupported();
    expect(manager.getVision()?.images).toBe(false);

    await manager.setModel('gpt-4.1');
    expect(manager.getVision()?.images).toBe(true);

    await manager.setModel('gpt-4o-mini');
    expect(manager.getVision()?.images).toBe(false);
  });

  it('reports no vision before a model is applied', () => {
    const manager = new ModelManager({ models: [createModelConfig()] });
    expect(manager.getVision()).toBeUndefined();
    expect(manager.getInputWindowTokens()).toBeUndefined();
  });
```

在 `src/session/__tests__/SessionModelConfig.test.ts` 的 `describe` 末尾追加：

```ts
  it('passes the vision override into agent runtime options', async () => {
    const vision = { maxImagesPerRequest: 1 };
    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'qwen-vl-max',
      vision,
    });

    const [, agentOptions] = createAgent.mock.calls.at(-1) ?? [];
    expect(agentOptions).toEqual(expect.objectContaining({ vision }));

    await session.close();
  });
```

- [ ] **Step 2: 确认测试失败**

Run: `pnpm vitest run src/images/__tests__/visionDefaults.test.ts src/agent/__tests__/ModelManager.setModel.test.ts src/session/__tests__/SessionModelConfig.test.ts`
Expected: FAIL：`visionDefaults.js` 不存在；`manager.getVision is not a function`；`agentOptions` 中没有 `vision`。

- [ ] **Step 3: 实现默认表与解析**

创建 `src/images/visionDefaults.ts`：

```ts
import { ConfigError } from '../errors/ConfigError.js';
import type {
  VisionCapability,
  VisionCapabilityOverride,
  VisionResolver,
} from '../model/vision.js';
import { normalizeDeepSeekModel } from '../services/deepseek.js';

const MIB = 1024 * 1024;

const ANTHROPIC_VISION: VisionCapability = {
  images: true,
  toolResultImages: true,
  imageTokens: 'anthropic',
  maxImageBytes: 5 * MIB,
  maxImagesPerRequest: 100,
};
const OPENAI_VISION: VisionCapability = {
  images: true,
  toolResultImages: true,
  imageTokens: 'openai',
  maxImageBytes: 20 * MIB,
};
// Azure routes through the OpenAI-compatible adapter, which turns tool result
// content into text, so images move out of tool results.
const AZURE_VISION: VisionCapability = {
  images: true,
  toolResultImages: false,
  imageTokens: 'openai',
};
const GEMINI_VISION: VisionCapability = {
  images: true,
  toolResultImages: true,
  imageTokens: 'gemini',
};
const NO_VISION: VisionCapability = { images: false, toolResultImages: false };

/** Capability assumed for models the table does not know: pass images through, as before. */
export const DEFAULT_VISION_CAPABILITY: VisionCapability = {
  images: true,
  toolResultImages: false,
  imageTokens: 1600,
};

const OPENAI_TEXT_ONLY_MODELS = [
  /^gpt-3\.5/,
  /^gpt-4(?:-0314|-0613)?$/,
  /^gpt-4-32k/,
  /^gpt-4-(?:0125|1106)-preview$/,
  /^o1-mini/,
  /^o1-preview/,
  /^o3-mini/,
];
const TEXT_ONLY_MODEL_HINTS = [/qwq/, /deepseek-r1/, /deepseek-v4-pro/, /o1-mini/, /o3-mini/, /gpt-3\.5/];

const matches = (patterns: readonly RegExp[], name: string) =>
  patterns.some((pattern) => pattern.test(name));

/** The built-in capability row for a provider and model name. */
export function builtinVisionCapability(provider: string, model: string): VisionCapability {
  const name = model.trim().toLowerCase();
  switch (provider) {
    case 'anthropic':
      return /^claude-(?:2|instant)/.test(name) ? NO_VISION : ANTHROPIC_VISION;
    case 'openai':
      return matches(OPENAI_TEXT_ONLY_MODELS, name) ? NO_VISION : OPENAI_VISION;
    case 'azure-openai':
      return matches(OPENAI_TEXT_ONLY_MODELS, name) ? NO_VISION : AZURE_VISION;
    case 'gemini':
      return GEMINI_VISION;
    case 'deepseek':
      return normalizeDeepSeekModel(name) === 'deepseek-v4-flash'
        ? DEFAULT_VISION_CAPABILITY
        : NO_VISION;
    default:
      return matches(TEXT_ONLY_MODEL_HINTS, name) ? NO_VISION : DEFAULT_VISION_CAPABILITY;
  }
}

function assertOverride(override: VisionCapabilityOverride, source: string): void {
  for (const key of ['maxImageBytes', 'maxImagesPerRequest'] as const) {
    const value = override[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new ConfigError(`${source}.${key} must be a positive safe integer`);
    }
  }
  const tokens = override.imageTokens;
  if (typeof tokens === 'number' && (!Number.isSafeInteger(tokens) || tokens < 1)) {
    throw new ConfigError(`${source}.imageTokens must be a positive safe integer or a formula name`);
  }
}

function applyOverride(
  base: VisionCapability,
  override: VisionCapabilityOverride | undefined,
): VisionCapability {
  if (!override) return base;
  const mediaTypes = override.mediaTypes ?? base.mediaTypes;
  const maxImageBytes = override.maxImageBytes ?? base.maxImageBytes;
  const maxImagesPerRequest = override.maxImagesPerRequest ?? base.maxImagesPerRequest;
  const imageTokens = override.imageTokens ?? base.imageTokens;
  return {
    images: override.images ?? base.images,
    toolResultImages: override.toolResultImages ?? base.toolResultImages,
    ...(mediaTypes ? { mediaTypes } : {}),
    ...(maxImageBytes !== undefined ? { maxImageBytes } : {}),
    ...(maxImagesPerRequest !== undefined ? { maxImagesPerRequest } : {}),
    ...(imageTokens !== undefined ? { imageTokens } : {}),
  };
}

export interface VisionResolutionInput {
  readonly provider: string;
  readonly model: string;
  readonly modelOverride?: VisionCapabilityOverride;
  readonly sessionOverride?: VisionCapabilityOverride | VisionResolver;
  /** The provider already said this model does not accept images. */
  readonly imagesUnsupported?: boolean;
}

/** Built-in row, then `ModelConfig.vision`, then `SessionOptions.vision`, then any runtime downgrade. */
export function resolveVisionCapability(input: VisionResolutionInput): VisionCapability {
  const sessionOverride =
    typeof input.sessionOverride === 'function'
      ? input.sessionOverride({ provider: input.provider, model: input.model })
      : input.sessionOverride;
  if (input.modelOverride) assertOverride(input.modelOverride, 'ModelConfig.vision');
  if (sessionOverride) assertOverride(sessionOverride, 'SessionOptions.vision');
  const resolved = applyOverride(
    applyOverride(builtinVisionCapability(input.provider, input.model), input.modelOverride),
    sessionOverride,
  );
  return input.imagesUnsupported ? { ...resolved, images: false } : resolved;
}
```

- [ ] **Step 4: ModelManager 解析并保存视觉能力**

`src/agent/ModelManager.ts`：

1. import 区加入：

```ts
import { resolveVisionCapability } from '../images/visionDefaults.js';
import type { VisionCapability, VisionCapabilityOverride, VisionResolver } from '../model/vision.js';
```

2. 在 `export class ModelManager {` 之前加 `const DEFAULT_MAX_OUTPUT_TOKENS = 8192;`。在 `private currentModelMaxContextTokens!: number;` 之后加：

```ts
  private currentMaxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
  private currentVision?: VisionCapability;
  private currentVisionKey?: string;
  private readonly imagelessModels = new Set<string>();
```

3. 构造函数参数列表在 `private readonly providerRegistry?: ProviderRegistry,` 之后加 `private readonly visionOverride?: VisionCapabilityOverride | VisionResolver,`。

4. 在 `getProviderRegistry()` 之后加：

```ts
  /** Image capability of the active model; undefined until a model is applied. */
  getVision(): VisionCapability | undefined {
    return this.currentVision;
  }

  /** Input tokens one request may use: the context window minus the output allowance. */
  getInputWindowTokens(): number | undefined {
    return this.currentVision === undefined
      ? undefined
      : Math.max(0, this.currentModelMaxContextTokens - this.currentMaxOutputTokens);
  }

  /** Stop sending images to the active model for as long as this manager lives. */
  markImagesUnsupported(): void {
    if (!this.currentVisionKey || !this.currentVision) return;
    this.imagelessModels.add(this.currentVisionKey);
    this.currentVision = { ...this.currentVision, images: false };
  }
```

5. 在 `applyModelConfig` 里，`this.currentModelMaxContextTokens = maxContextTokens;` 之后加：

```ts
    const visionKey = `${modelConfig.provider}\u0000${modelConfig.model}`;
    const vision = resolveVisionCapability({
      provider: modelConfig.provider,
      model: modelConfig.model,
      modelOverride: modelConfig.vision,
      sessionOverride: this.visionOverride,
      imagesUnsupported: this.imagelessModels.has(visionKey),
    });
```

在传给 `createModelService` 的对象里，`outputFormat: this.outputFormat,` 之后加 `vision,`。方法末尾 `this.config.currentModelId = modelConfig.id;` 之后加：

```ts
    this.currentMaxOutputTokens = modelConfig.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.currentVision = vision;
    this.currentVisionKey = visionKey;
```

- [ ] **Step 5: 透传 `SessionOptions.vision`**

`src/agent/types.ts`：import 区加 `import type { VisionCapabilityOverride, VisionResolver } from '../model/vision.js';`，在 `AgentRuntimeOptions` 的 `localDiscovery?: boolean;` 之后加：

```ts
  /** Override of the resolved image capability; see `SessionOptions.vision`. */
  vision?: VisionCapabilityOverride | VisionResolver;
```

`src/agent/Agent.ts`：构造函数里 `new ModelManager(...)` 的参数列表在 `deps.providerRegistry,` 之后加 `runtimeOptions.vision,`。

`src/session/SessionLifecycle.ts`：`Agent.create` 的第二个参数对象在 `tokenBudget: this.state.options.tokenBudget,` 之后加 `vision: this.state.options.vision,`。

- [ ] **Step 6: 确认通过**

Run: `pnpm vitest run src/images/__tests__/visionDefaults.test.ts src/agent/__tests__ src/session/__tests__/SessionModelConfig.test.ts`
Expected: 全部通过。

- [ ] **Step 7: 提交**

```bash
pnpm lint:fix && pnpm type-check
git add src/images/visionDefaults.ts src/images/__tests__/visionDefaults.test.ts src/agent/ModelManager.ts src/agent/types.ts src/agent/Agent.ts src/session/SessionLifecycle.ts src/agent/__tests__/ModelManager.setModel.test.ts src/session/__tests__/SessionModelConfig.test.ts
git commit -m "feat(images): resolve the vision capability of the active model"
```

---

### Task 5: 图片 token 估算与 TokenCounter

**Files:**
- Create: `src/images/estimateImageTokens.ts`
- Modify: `src/context/TokenCounter.ts`
- Test: `src/images/__tests__/estimateImageTokens.test.ts`
- Modify (test): `src/context/__tests__/TokenCounter.test.ts`
- Create: `.changes/image-token-estimates.json`

**Interfaces:**
- Consumes：Task 2 的 `parseBase64DataUrl`、`base64PrefixToBytes`、`inspectImageBytes`；Task 1 的 `ImageRef`、`VisionCapability`。
- Produces：
  - `DEFAULT_IMAGE_TOKENS = 1600`
  - `estimateImageTokens(ref: ImageRef, vision?: Pick<VisionCapability, 'imageTokens'>): number`
  - `TokenCountOptions { readonly vision?: Pick<VisionCapability, 'imageTokens'> }`
  - `countTokens(messages, modelName, options?: TokenCountOptions)`（第三个参数可选，现有调用方不受影响）

- [ ] **Step 1: 写失败测试**

创建 `src/images/__tests__/estimateImageTokens.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_TOKENS, estimateImageTokens } from '../estimateImageTokens.js';
import { dataUrl, pngBytes } from './fixtures.js';

describe('estimateImageTokens', () => {
  it.each([
    ['openai 1024×1024', 1024, 1024, 'openai', 765],
    ['openai 2048×4096', 2048, 4096, 'openai', 1105],
    ['openai 512×512', 512, 512, 'openai', 255],
    ['anthropic 1092×1092', 1092, 1092, 'anthropic', 1590],
    ['anthropic 200×200', 200, 200, 'anthropic', 54],
    ['anthropic 4000×3000', 4000, 3000, 'anthropic', 1600],
    ['gemini 384×384', 384, 384, 'gemini', 258],
    ['gemini 1920×1080', 1920, 1080, 'gemini', 1548],
  ] as const)('%s', (_name, width, height, imageTokens, expected) => {
    expect(
      estimateImageTokens({ url: 'blade-image:sha256:x', width, height }, { imageTokens }),
    ).toBe(expected);
  });

  it('charges 85 tokens for low detail on the openai formula', () => {
    expect(
      estimateImageTokens(
        { url: 'x', detail: 'low', width: 4000, height: 4000 },
        { imageTokens: 'openai' },
      ),
    ).toBe(85);
  });

  it('uses a fixed count when the capability gives one', () => {
    expect(estimateImageTokens({ url: 'x', width: 4000, height: 4000 }, { imageTokens: 1234 })).toBe(
      1234,
    );
  });

  it('reads the size from an inline data URL when the reference has none', () => {
    const url = dataUrl('image/png', pngBytes(1024, 1024, 2048));
    expect(estimateImageTokens({ url }, { imageTokens: 'openai' })).toBe(765);
  });

  it('falls back to the default when the size is unknown', () => {
    expect(estimateImageTokens({ url: 'https://example.test/a.png' }, { imageTokens: 'anthropic' })).toBe(
      DEFAULT_IMAGE_TOKENS,
    );
    expect(estimateImageTokens({ url: 'https://example.test/a.png' })).toBe(DEFAULT_IMAGE_TOKENS);
  });
});
```

在 `src/context/__tests__/TokenCounter.test.ts` 顶部加入 `import { dataUrl, pngBytes } from '../../images/__tests__/fixtures.js';`，并在 `describe('countTokens', ...)` 里追加：

```ts
    it('estimates images from their size instead of tokenizing base64', () => {
      TokenCounter.countTokens([{ role: 'user', content: 'warm up' }], 'gpt-4o');
      const url = dataUrl('image/png', pngBytes(1920, 1080, 1024 * 1024));
      const messages: ModelMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is in this screenshot?' },
            { type: 'image_url', image_url: { url } },
          ],
        },
      ];

      const started = performance.now();
      const tokens = TokenCounter.countTokens(messages, 'gpt-4o', {
        vision: { imageTokens: 'openai' },
      });

      expect(performance.now() - started).toBeLessThan(50);
      expect(tokens).toBeGreaterThan(1_000);
      expect(tokens).toBeLessThan(5_000);
    });
```

- [ ] **Step 2: 确认测试失败**

Run: `pnpm vitest run src/images/__tests__/estimateImageTokens.test.ts src/context/__tests__/TokenCounter.test.ts`
Expected: FAIL：`estimateImageTokens.js` 不存在；TokenCounter 新用例中 tokens 远大于 5,000（约 95 万），耗时也超过 50ms。

- [ ] **Step 3: 实现估算器**

创建 `src/images/estimateImageTokens.ts`：

```ts
import type { ImageRef } from '../model/image.js';
import type { VisionCapability } from '../model/vision.js';
import { base64PrefixToBytes, parseBase64DataUrl } from './base64.js';
import { inspectImageBytes } from './imageBytes.js';

/** Estimate for an image whose size is unknown; about one 1080p screenshot on any provider. */
export const DEFAULT_IMAGE_TOKENS = 1_600;
const HEADER_PROBE_BYTES = 64 * 1024;

interface Size {
  readonly width: number;
  readonly height: number;
}

function imageSize(ref: ImageRef): Size | undefined {
  if (ref.width && ref.height) return { width: ref.width, height: ref.height };
  const inline = parseBase64DataUrl(ref.url);
  if (!inline) return undefined;
  const facts = inspectImageBytes(base64PrefixToBytes(inline.base64, HEADER_PROBE_BYTES));
  return facts?.width && facts.height ? { width: facts.width, height: facts.height } : undefined;
}

function openAiTokens({ width, height }: Size): number {
  const fit = Math.min(1, 2048 / Math.max(width, height));
  let scaledWidth = width * fit;
  let scaledHeight = height * fit;
  const shortest = Math.min(scaledWidth, scaledHeight);
  if (shortest > 768) {
    scaledWidth *= 768 / shortest;
    scaledHeight *= 768 / shortest;
  }
  return 85 + 170 * Math.ceil(scaledWidth / 512) * Math.ceil(scaledHeight / 512);
}

function anthropicTokens({ width, height }: Size): number {
  const scale = Math.min(1, 1568 / Math.max(width, height));
  return Math.min(1600, Math.ceil((width * scale * height * scale) / 750));
}

function geminiTokens({ width, height }: Size): number {
  return width <= 384 && height <= 384
    ? 258
    : 258 * Math.ceil(width / 768) * Math.ceil(height / 768);
}

/**
 * Conservative token estimate for sending `ref`. It uses the pixel size and the
 * provider formula and never tokenizes base64. Billing stays the provider's.
 */
export function estimateImageTokens(
  ref: ImageRef,
  vision?: Pick<VisionCapability, 'imageTokens'>,
): number {
  const formula = vision?.imageTokens ?? DEFAULT_IMAGE_TOKENS;
  if (typeof formula === 'number') return formula;
  if (formula === 'openai' && ref.detail === 'low') return 85;
  const size = imageSize(ref);
  if (!size) return DEFAULT_IMAGE_TOKENS;
  switch (formula) {
    case 'openai':
      return openAiTokens(size);
    case 'anthropic':
      return anthropicTokens(size);
    case 'gemini':
      return geminiTokens(size);
  }
}
```

- [ ] **Step 4: TokenCounter 改用估算器**

`src/context/TokenCounter.ts`：

1. import 改为：

```ts
import { encodingForModel } from 'js-tiktoken';
import { estimateImageTokens } from '../images/estimateImageTokens.js';
import type { ModelContent, ModelMessage, ModelToolCall } from '../model/message.js';
import type { VisionCapability } from '../model/vision.js';
```

2. 在 `countToolCallTokens` 之后加：

```ts
export interface TokenCountOptions {
  /** Image capability of the model; images are estimated from their size, never from base64. */
  readonly vision?: Pick<VisionCapability, 'imageTokens'>;
}

function countContentTokens(
  content: readonly ModelContent[],
  encoding: Encoding,
  options: TokenCountOptions,
): number {
  let tokens = 0;
  for (const part of content) {
    tokens +=
      part.type === 'text'
        ? encoding.encode(part.text).length
        : estimateImageTokens(part.image_url, options.vision);
  }
  return tokens;
}
```

3. `countTokens` 签名改为 `export function countTokens(messages: ModelMessage[], modelName: string, options: TokenCountOptions = {}): number`，把其中的：

```ts
    if (msg.content) {
      if (typeof msg.content === 'string') {
        totalTokens += encoding.encode(msg.content).length;
      } else {
        totalTokens += encoding.encode(JSON.stringify(msg.content)).length;
      }
    }
```

替换为：

```ts
    if (msg.content) {
      totalTokens +=
        typeof msg.content === 'string'
          ? encoding.encode(msg.content).length
          : countContentTokens(msg.content, encoding, options);
    }
```

- [ ] **Step 5: 加 changelog fragment**

创建 `.changes/image-token-estimates.json`：

```json
{
  "type": "fix",
  "en": "Token estimates now count an image from its pixel size with the provider's formula instead of tokenizing its base64 data, so one screenshot no longer looks like hundreds of thousands of tokens or triggers emergency context truncation.",
  "zh-CN": "token 估算现在按图片尺寸和 provider 公式计算图片，不再对 base64 数据分词；一张截图不会再被估成几十万 tokens，也不会再触发上下文紧急截断。"
}
```

- [ ] **Step 6: 确认通过**

Run: `pnpm vitest run src/images/__tests__/estimateImageTokens.test.ts src/context/__tests__/TokenCounter.test.ts && pnpm changelog:check`
Expected: 全部通过，changelog 校验通过。

- [ ] **Step 7: 提交**

```bash
pnpm lint:fix && pnpm type-check
git add src/images/estimateImageTokens.ts src/images/__tests__/estimateImageTokens.test.ts src/context/TokenCounter.ts src/context/__tests__/TokenCounter.test.ts .changes/image-token-estimates.json
git commit -m "fix(context): estimate image tokens from image size instead of base64"
```

---

### Task 6: 图片描述文本与压缩

**Files:**
- Create: `src/images/imageText.ts`
- Modify: `src/context/CompactionService.ts`
- Modify: `src/agent/CompactionHandler.ts`
- Modify: `src/agent/LoopHookBuilder.ts`（`compactAtTurnLimit`）
- Modify: `src/agent/Agent.ts`（构造 `CompactionHandler` 时传入 vision getter）
- Test: `src/images/__tests__/imageText.test.ts`
- Modify (test): `src/context/__tests__/CompactionService.test.ts`、`src/agent/__tests__/CompactionHandler.test.ts`
- Create: `.changes/compaction-image-descriptions.json`

**Interfaces:**
- Consumes：Task 5 的 `TokenCountOptions`；Task 4 的 `ModelManager.getVision()`。
- Produces：
  - `ImageOmissionReason = 'budget' | 'unsupported' | 'unavailable'`
  - `describeImage(ref: ImageRef): string`，格式为 `image/png 1280×720 — alt`，未知字段省略
  - `summaryImageText(ref: ImageRef): string`，返回 `[image: …]` 或 `[image]`
  - `imagePlaceholder(reason: ImageOmissionReason, ref: ImageRef): string`
  - `CompactionOptions.vision?: VisionCapability`
  - `CompactionHandler` 构造函数第 5 个参数 `getVision: () => VisionCapability | undefined`

- [ ] **Step 1: 写失败测试**

创建 `src/images/__tests__/imageText.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { describeImage, imagePlaceholder, summaryImageText } from '../imageText.js';

describe('image text', () => {
  it('describes what is known about an image', () => {
    expect(
      describeImage({
        url: 'x',
        mediaType: 'image/png',
        width: 1280,
        height: 720,
        alt: ' login page ',
      }),
    ).toBe('image/png 1280×720 — login page');
    expect(describeImage({ url: 'x', mediaType: 'image/png' })).toBe('image/png');
    expect(describeImage({ url: 'x', alt: 'chart' })).toBe('chart');
    expect(describeImage({ url: 'x' })).toBe('');
  });

  it('renders compaction text and request placeholders', () => {
    const ref = { url: 'x', mediaType: 'image/webp', width: 2, height: 3 };
    expect(summaryImageText(ref)).toBe('[image: image/webp 2×3]');
    expect(summaryImageText({ url: 'x' })).toBe('[image]');
    expect(imagePlaceholder('budget', ref)).toBe(
      '[image omitted to fit the image budget: image/webp 2×3]',
    );
    expect(imagePlaceholder('budget', { url: 'x' })).toBe('[image omitted to fit the image budget]');
    expect(imagePlaceholder('unsupported', ref)).toBe(
      '[image omitted: the current model does not accept images — image/webp 2×3]',
    );
    expect(imagePlaceholder('unsupported', { url: 'x' })).toBe(
      '[image omitted: the current model does not accept images]',
    );
    expect(imagePlaceholder('unavailable', ref)).toBe(
      '[image unavailable: it is no longer in the image store]',
    );
  });
});
```

在 `src/context/__tests__/CompactionService.test.ts` 顶部加入 `import { dataUrl, pngBytes } from '../../images/__tests__/fixtures.js';`，并在 `describe('CompactionService', ...)` 里追加：

```ts
  it('describes images in the summary prompt instead of sending base64', async () => {
    const url = dataUrl('image/png', pngBytes(1920, 1080, 1024 * 1024));
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Why does the login page look broken?' },
          {
            type: 'image_url',
            image_url: { url, mediaType: 'image/png', width: 1920, height: 1080, alt: 'login page' },
          },
        ],
      },
      { role: 'assistant', content: 'The submit button overlaps the footer.' },
    ];

    await compact(messages, {
      trigger: 'manual',
      modelName: 'gpt-5',
      maxContextTokens: 128000,
      apiKey: 'test-key',
      baseURL: 'https://api.openai.com/v1',
    });

    expect(mockSideQuery).toHaveBeenCalledTimes(1);
    const prompt = String((mockSideQuery.mock.calls[0]?.[0] as ModelMessage[])[0]?.content);
    expect(prompt).not.toContain(';base64,');
    expect(prompt).toContain('[image: image/png 1920×1080 — login page]');
    expect(prompt).toContain('Why does the login page look broken?');
  });
```

在 `src/agent/__tests__/CompactionHandler.test.ts` 顶部加入 `import { dataUrl, pngBytes } from '../../images/__tests__/fixtures.js';`，并在 `describe('CompactionHandler', ...)` 里追加：

```ts
  it('re-estimates images by size after microcompact instead of truncating the conversation', async () => {
    const handler = new CompactionHandler(
      () =>
        ({
          getConfig: () => ({
            model: 'gpt-4o',
            provider: 'openai' as const,
            maxContextTokens: 128000,
            maxOutputTokens: 8000,
            apiKey: 'test-key',
            baseUrl: 'https://api.openai.com/v1',
          }),
        }) as never,
      () => undefined,
      undefined,
      undefined,
      () => ({ images: true, toolResultImages: true, imageTokens: 'openai' }),
    );
    const url = dataUrl('image/png', pngBytes(1920, 1080, 1024 * 1024));
    const filler: ModelMessage[] = Array.from({ length: 44 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `step ${index}`,
    }));
    const contextMessages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Compare with this screenshot' },
          { type: 'image_url', image_url: { url } },
        ],
      },
      ...filler,
      { role: 'tool', tool_call_id: 'call-1', content: 'x'.repeat(4000) },
      { role: 'tool', tool_call_id: 'call-2', content: 'y'.repeat(4000) },
    ];
    const convState = new ConversationState(
      null,
      contextMessages.slice(0, -1),
      contextMessages[contextMessages.length - 1] as ModelMessage,
    );

    const events: unknown[] = [];
    const stream = handler.checkAndCompactInLoop(
      convState,
      { sessionId: SessionId('session-1') },
      3,
      80_000,
    );
    let didCompact: boolean | undefined;
    while (true) {
      const next = await stream.next();
      if (next.done) {
        didCompact = next.value;
        break;
      }
      events.push(next.value);
    }

    expect(didCompact).toBe(true);
    expect(events).toEqual([]);
    expect(convState.getContextMessages()).toHaveLength(contextMessages.length);
    expect(mockCompact).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: 确认测试失败**

Run: `pnpm vitest run src/images/__tests__/imageText.test.ts src/context/__tests__/CompactionService.test.ts src/agent/__tests__/CompactionHandler.test.ts`
Expected: FAIL：
- `imageText.js` 不存在；
- 摘要 prompt 含 `;base64,`，且 `mockSideQuery` 被调用了十多次；
- CompactionHandler 新用例产生了 `compacting` 事件，消息数被截断到 40。

- [ ] **Step 3: 实现**

创建 `src/images/imageText.ts`：

```ts
import type { ImageRef } from '../model/image.js';

/** Why an image was left out of a model request. */
export type ImageOmissionReason = 'budget' | 'unsupported' | 'unavailable';

/** `image/png 1280×720 — alt`, leaving out whatever is unknown. */
export function describeImage(ref: ImageRef): string {
  const size = ref.width && ref.height ? `${ref.width}×${ref.height}` : '';
  const meta = [ref.mediaType ?? '', size].filter((value) => value !== '').join(' ');
  const alt = ref.alt?.trim() ?? '';
  if (meta && alt) return `${meta} — ${alt}`;
  return meta || alt;
}

/** How compaction shows an image to the summary model. */
export function summaryImageText(ref: ImageRef): string {
  const description = describeImage(ref);
  return description ? `[image: ${description}]` : '[image]';
}

/** Deterministic text that takes an omitted image's place, so prompt caching still works. */
export function imagePlaceholder(reason: ImageOmissionReason, ref: ImageRef): string {
  const description = describeImage(ref);
  switch (reason) {
    case 'budget':
      return description
        ? `[image omitted to fit the image budget: ${description}]`
        : '[image omitted to fit the image budget]';
    case 'unsupported':
      return description
        ? `[image omitted: the current model does not accept images — ${description}]`
        : '[image omitted: the current model does not accept images]';
    case 'unavailable':
      return '[image unavailable: it is no longer in the image store]';
  }
}
```

`src/context/CompactionService.ts`：

1. import 区加：

```ts
import { summaryImageText } from '../images/imageText.js';
import type { ModelContent, ModelMessage } from '../model/message.js';
import type { VisionCapability } from '../model/vision.js';
```

同时删掉原来的 `import type { ModelMessage } from '../model/message.js';`。

2. `CompactionOptions` 在 `assertExecutionLease` 字段之前加：

```ts
  /** Image capability of the model, used for token estimates. */
  vision?: VisionCapability;
```

3. 文件里三处 `TokenCounter.countTokens(<messages>, options.modelName)` 都改为 `TokenCounter.countTokens(<messages>, options.modelName, { vision: options.vision })`，分别在 `compact()` 的 preTokens 和 postTokens，以及 `fallbackCompact()` 里。

4. `buildCompactionSections` 里的：

```ts
    const content =
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
```

改为：

```ts
    const content =
      typeof message.content === 'string' ? message.content : renderSummaryContent(message.content);
```

并在 `buildCompactionSections` 之后加：

```ts
function renderSummaryContent(content: readonly ModelContent[]): string {
  return content
    .map((part) => (part.type === 'text' ? part.text : summaryImageText(part.image_url)))
    .join('\n');
}
```

`src/agent/CompactionHandler.ts`：

1. import 区加 `import type { VisionCapability } from '../model/vision.js';`。
2. 构造函数在 `private getProviderRegistry: () => ProviderRegistry | undefined = () => undefined,` 之后加 `private getVision: () => VisionCapability | undefined = () => undefined,`。
3. `checkAndCompactInLoop` 里的 `TokenCounter.countTokens(convState.getContextMessages(), modelName)` 改为 `TokenCounter.countTokens(convState.getContextMessages(), modelName, { vision: this.getVision() })`。
4. `reactiveCompact` 里的 `TokenCounter.countTokens(workingMessages, this.getModelService().getConfig().model)` 改为 `TokenCounter.countTokens(workingMessages, this.getModelService().getConfig().model, { vision: this.getVision() })`。
5. 两处 `CompactionService.compact(...)` 的 options 对象里，`assertExecutionLease: runtimeCtx.assertExecutionLease,` 之后加 `vision: this.getVision(),`。

`src/agent/LoopHookBuilder.ts`：`compactAtTurnLimit` 里 `CompactionService.compact` 的 options 对象中，`assertExecutionLease: deps.context.assertExecutionLease,` 之后加 `vision: deps.modelManager.getVision(),`。

`src/agent/Agent.ts`：`initialize()` 里的 `new CompactionHandler(...)` 在 `() => this.modelManager.getProviderRegistry(),` 之后加 `() => this.modelManager.getVision(),`。

- [ ] **Step 4: 加 changelog fragment**

创建 `.changes/compaction-image-descriptions.json`：

```json
{
  "type": "fix",
  "en": "Context compaction describes images as `[image: …]` text instead of sending their base64 data to the summary model, which used to split one screenshot into many summary requests.",
  "zh-CN": "上下文压缩把图片写成 `[image: …]` 描述，不再把 base64 数据发给摘要模型；之前一张截图会被切成很多次摘要请求。"
}
```

- [ ] **Step 5: 确认通过**

Run: `pnpm vitest run src/images/__tests__/imageText.test.ts src/context/__tests__ src/agent/__tests__ && pnpm changelog:check`
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
pnpm lint:fix && pnpm type-check
git add src/images/imageText.ts src/images/__tests__/imageText.test.ts src/context/CompactionService.ts src/agent/CompactionHandler.ts src/agent/LoopHookBuilder.ts src/agent/Agent.ts src/context/__tests__/CompactionService.test.ts src/agent/__tests__/CompactionHandler.test.ts .changes/compaction-image-descriptions.json
git commit -m "fix(context): describe images in compaction instead of sending base64"
```

---
### Task 7: schema、拷贝与协议握手兼容

**Files:**
- Create: `src/images/imageRefSchema.ts`
- Modify: `src/protocol/schemas.ts`（`imageInputSchema`、`agentInitializationDataSchema.features`）
- Modify: `src/session/streamSchema.ts`（`modelContentSchema`）
- Modify: `src/session/DurableRequestRecovery.ts`（图片分支）
- Modify: `src/services/messageUtils.ts`（`cloneContentPart`）
- Test: `src/services/__tests__/messageUtils.test.ts`
- Modify (test): `src/protocol/__tests__/protocol.test.ts`、`src/session/__tests__/streamSchema.test.ts`、`src/session/__tests__/DurableRequestRecovery.test.ts`

**Interfaces:**
- Produces：`imageRefMetadataShape`，一个 zod shape，包含 `detail`、`mediaType`、`width`、`height`、`byteLength`、`alt`，全部可选。三处 schema 各自保留原来的 `url` 规则：protocol 要求 `min(1)`，stream 和 durable 只要求是字符串。

- [ ] **Step 1: 写失败测试**

在 `src/protocol/__tests__/protocol.test.ts` 的 `describe('agent protocol v1', ...)` 里追加：

```ts
  it('accepts image references with metadata in input.submit', () => {
    const imageCommand = (imageUrl: Record<string, unknown>) => ({
      protocolVersion: AGENT_PROTOCOL_VERSION,
      commandId: 'command-image',
      type: AgentCommandType.INPUT_SUBMIT,
      data: { sessionId: 'session-1', input: [{ type: 'image_url', image_url: imageUrl }] },
    });

    expect(
      parseAgentCommand(
        imageCommand({
          url: `blade-image:sha256:${'a'.repeat(64)}`,
          detail: 'low',
          mediaType: 'image/png',
          width: 1280,
          height: 720,
          byteLength: 4096,
          alt: 'login page',
        }),
      ),
    ).toMatchObject({ data: { input: [{ image_url: { detail: 'low', width: 1280 } }] } });
    expect(() => parseAgentCommand(imageCommand({ url: 'x', detail: 'max' }))).toThrow();
    expect(() => parseAgentCommand(imageCommand({ url: 'x', unknown: true }))).toThrow();
  });

  it('drops feature flags it does not know from initialize data', () => {
    const features = {
      approvals: true,
      durableEvents: true,
      eventReplay: true,
      idempotentCommands: true,
    } as const;
    const data = {
      protocolVersion: AGENT_PROTOCOL_VERSION,
      commands: Object.values(AgentCommandType),
      transports: ['http-sse'],
      serverTime: new Date().toISOString(),
      features: { ...features, images: true },
    };

    expect(agentInitializationDataSchema.parse(data)).toEqual({ ...data, features });
  });
```

在 `src/session/__tests__/streamSchema.test.ts` 的 `describe('parseSessionStreamEvent', ...)` 里追加：

```ts
  it('accepts image metadata on message content', () => {
    expect(
      parseSessionStreamEvent(
        toolMessageEvent({
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `blade-image:sha256:${'b'.repeat(64)}`,
                mediaType: 'image/png',
                width: 2,
                height: 2,
                byteLength: 70,
              },
            },
          ],
        }),
      ),
    ).toMatchObject({ messages: [{ content: [{ image_url: { width: 2, byteLength: 70 } }] }] });
  });
```

在 `src/session/__tests__/DurableRequestRecovery.test.ts` 的 `describe('DurableRequestRecovery', ...)` 里追加：

```ts
  it('keeps image metadata when recovering request content', () => {
    const image = {
      url: `blade-image:sha256:${'c'.repeat(64)}`,
      detail: 'high',
      mediaType: 'image/webp',
      width: 640,
      height: 480,
      byteLength: 1234,
      alt: 'chart',
    } as const;

    expect(parseDurableUserMessageContent([{ type: 'image_url', image_url: image }])).toEqual([
      { type: 'image_url', image_url: image },
    ]);
    expect(() =>
      parseDurableUserMessageContent([{ type: 'image_url', image_url: { url: 'x', width: -1 } }]),
    ).toThrow(SessionDurableRecorderError);
  });
```

创建 `src/services/__tests__/messageUtils.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { ModelContent } from '../../model/message.js';
import { cloneContentPart } from '../messageUtils.js';

describe('cloneContentPart', () => {
  it('copies every image reference field', () => {
    const part: ModelContent = {
      type: 'image_url',
      image_url: {
        url: `blade-image:sha256:${'d'.repeat(64)}`,
        detail: 'low',
        mediaType: 'image/png',
        width: 3,
        height: 4,
        byteLength: 99,
        alt: 'diagram',
      },
    };

    const clone = cloneContentPart(part);

    expect(clone).toEqual(part);
    if (clone.type !== 'image_url' || part.type !== 'image_url') {
      throw new Error('Expected image parts');
    }
    expect(clone.image_url).not.toBe(part.image_url);
  });
});
```

- [ ] **Step 2: 确认测试失败**

Run: `pnpm vitest run src/protocol/__tests__/protocol.test.ts src/session/__tests__/streamSchema.test.ts src/session/__tests__/DurableRequestRecovery.test.ts src/services/__tests__/messageUtils.test.ts`
Expected: FAIL：
- protocol 用例因为 strict schema 拒绝 `detail` 等字段而抛错；
- 握手数据因为 `images` 是未知 key 而失败；
- stream 用例同样被拒；
- durable 用例丢失了元数据；
- clone 结果只剩 `url`。

- [ ] **Step 3: 实现**

创建 `src/images/imageRefSchema.ts`：

```ts
import { z } from 'zod';

/**
 * Optional `ImageRef` fields. The protocol, stream and durable schemas each keep
 * their own `url` rule and spread these, so all three accept the same metadata.
 */
export const imageRefMetadataShape = {
  detail: z.enum(['auto', 'low', 'high']).optional(),
  mediaType: z.string().min(1).max(255).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  byteLength: z.number().int().nonnegative().optional(),
  alt: z.string().optional(),
};
```

`src/protocol/schemas.ts`：
- import 区加 `import { imageRefMetadataShape } from '../images/imageRefSchema.js';`。
- `imageInputSchema` 改为：

```ts
const imageInputSchema = z
  .object({
    type: z.literal('image_url'),
    image_url: z
      .object({
        url: z.string().min(1),
        ...imageRefMetadataShape,
      })
      .strict(),
  })
  .strict();
```

- `agentInitializationDataSchema` 里的 `features` 去掉 `.strict()`，并加注释：

```ts
    // A newer server may advertise more features; unknown keys are dropped
    // instead of failing the handshake.
    features: z.object({
      approvals: z.literal(true),
      durableEvents: z.literal(true),
      eventReplay: z.literal(true),
      idempotentCommands: z.literal(true),
    }),
```

`src/session/streamSchema.ts`：import 区加 `import { imageRefMetadataShape } from '../images/imageRefSchema.js';`，把 `modelContentSchema` 中图片的那一项改为：

```ts
  z
    .object({
      type: z.literal('image_url'),
      image_url: z.object({ url: z.string(), ...imageRefMetadataShape }).strict(),
    })
    .strict(),
```

`src/session/DurableRequestRecovery.ts`：
- import 区加 `import { z } from 'zod';` 和 `import { imageRefMetadataShape } from '../images/imageRefSchema.js';`。
- 在 `isJsonObject` 之后加：

```ts
const durableImageRefSchema = z.object({ url: z.string(), ...imageRefMetadataShape }).strict();
```

- 把 `parseDurableUserMessageContent` 中的：

```ts
    if (
      value.type === 'image_url' &&
      isJsonObject(value.image_url) &&
      typeof value.image_url.url === 'string'
    ) {
      return {
        type: 'image_url',
        image_url: {
          url: value.image_url.url,
        },
      };
    }
```

替换为：

```ts
    if (value.type === 'image_url') {
      const image = durableImageRefSchema.safeParse(value.image_url);
      if (image.success) {
        return { type: 'image_url', image_url: image.data };
      }
    }
```

`src/services/messageUtils.ts`：`cloneContentPart` 的图片分支改为：

```ts
  return {
    type: 'image_url',
    image_url: { ...part.image_url },
  };
```

- [ ] **Step 4: 确认通过**

Run: `pnpm vitest run src/protocol src/session/__tests__/streamSchema.test.ts src/session/__tests__/DurableRequestRecovery.test.ts src/services/__tests__/messageUtils.test.ts src/browser src/hooks`
Expected: 全部通过。旧用例（只有 `{ url }`、`image_url: {}` 被拒绝）保持不变。

- [ ] **Step 5: 提交**

```bash
pnpm lint:fix && pnpm type-check
git add src/images/imageRefSchema.ts src/protocol/schemas.ts src/session/streamSchema.ts src/session/DurableRequestRecovery.ts src/services/messageUtils.ts src/protocol/__tests__/protocol.test.ts src/session/__tests__/streamSchema.test.ts src/session/__tests__/DurableRequestRecovery.test.ts src/services/__tests__/messageUtils.test.ts
git commit -m "feat(images): carry image metadata through schemas and clones"
```

---

### Task 8: 入口规范化与 ImageRuntime

**Files:**
- Modify: `src/errors/SessionInputError.ts`、`src/errors/index.ts`、`src/index.ts`
- Modify: `src/images/ImagePolicy.ts`（默认值、校验、解析）
- Create: `src/images/normalizeImages.ts`
- Create: `src/images/ImageRuntime.ts`
- Modify: `src/session/SessionRuntime.ts`
- Modify: `src/agent/Agent.ts`
- Modify: `src/session/SessionRequestCoordinator.ts`
- Test: `src/images/__tests__/ImagePolicy.test.ts`、`src/images/__tests__/normalizeImages.test.ts`、`src/images/__tests__/ImageRuntime.test.ts`
- Test: `src/session/__tests__/SessionImages.test.ts`
- Modify (test): `src/session/__tests__/SessionContext.test.ts`、`src/session/__tests__/SessionModelConfig.test.ts`

**Interfaces:**
- Consumes：Task 2 的 base64 工具与 `inspectImageBytes`、`IMAGE_MEDIA_TYPES`；Task 3 的 `InMemoryImageStore`；Task 4 的 `resolveVisionCapability`、`DEFAULT_VISION_CAPABILITY`、`ModelManager.getVision()` / `getInputWindowTokens()` / `markImagesUnsupported()`。
- Produces：
  - `ImageRejectionReason = 'unsupported_model' | 'too_large' | 'too_many' | 'media_type' | 'remote_url' | 'unresolvable'`
  - `SessionInputErrorDetails { readonly index: number; readonly reason: ImageRejectionReason }`
  - `SessionInputError` 的构造参数为 `(code, message, options?: { cause?; details? })`，并新增 `readonly details?`
  - `ResolvedImagePolicy { store?; maxImageBytes; maxImagesPerInput; historyTokens; maxImagesPerRequest; whenUnsupported; remoteUrls; mediaTypes: readonly string[] }`
  - `assertImagePolicy(policy?: ImagePolicy): void`
  - `resolveImagePolicy(policy: ImagePolicy | undefined, context: { vision: VisionCapability; inputWindowTokens?: number }): ResolvedImagePolicy`
  - 常量：`DEFAULT_MAX_IMAGE_BYTES`、`DEFAULT_MAX_IMAGES_PER_INPUT`、`DEFAULT_MAX_IMAGES_PER_REQUEST`、`DEFAULT_HISTORY_IMAGE_TOKENS`
  - `class ImageRejection extends Error { readonly index: number; readonly reason: ImageRejectionReason }`
  - `normalizeImageContent(content: string | ModelContent[], context: { policy: ResolvedImagePolicy; vision: VisionCapability; signal?: AbortSignal }): Promise<string | ModelContent[]>`
  - `ImageModelBinding { getVision(): VisionCapability | undefined; getInputWindowTokens(): number | undefined; markImagesUnsupported(): void }`
  - `class ImageRuntime`：`constructor({ policy?, fallbackVision?, logger? })`、`bindModel(binding)`、`vision()`、`policy()`、`normalizeUserContent(content, signal?)`（抛 `SessionInputError`）、`markImagesUnsupported()`
  - `AgentRuntimeDeps.imageRuntime?: ImageRuntime`
  - `SessionRuntime.getImageRuntime(): ImageRuntime`

- [ ] **Step 1: 写失败测试**

创建 `src/images/__tests__/ImagePolicy.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../errors/ConfigError.js';
import { IMAGE_MEDIA_TYPES } from '../imageBytes.js';
import { assertImagePolicy, resolveImagePolicy } from '../ImagePolicy.js';
import { InMemoryImageStore } from '../InMemoryImageStore.js';

const MIB = 1024 * 1024;

describe('resolveImagePolicy', () => {
  it('derives defaults from the model capability and the input window', () => {
    expect(
      resolveImagePolicy(undefined, {
        vision: {
          images: true,
          toolResultImages: true,
          maxImageBytes: 5 * MIB,
          maxImagesPerRequest: 100,
        },
        inputWindowTokens: 120_000,
      }),
    ).toEqual({
      maxImageBytes: 5 * MIB,
      maxImagesPerInput: 20,
      historyTokens: 16_000,
      maxImagesPerRequest: 100,
      whenUnsupported: 'reject',
      remoteUrls: true,
      mediaTypes: IMAGE_MEDIA_TYPES,
    });
    expect(
      resolveImagePolicy(undefined, {
        vision: { images: true, toolResultImages: false },
        inputWindowTokens: 24_000,
      }).historyTokens,
    ).toBe(6_000);
    expect(
      resolveImagePolicy(undefined, { vision: { images: true, toolResultImages: false } }),
    ).toMatchObject({ maxImageBytes: 10 * MIB, maxImagesPerRequest: 50, historyTokens: 16_000 });
  });

  it('lets the policy override every default', () => {
    const store = new InMemoryImageStore();
    expect(
      resolveImagePolicy(
        {
          store,
          maxImageBytes: 1024,
          maxImagesPerInput: 2,
          historyTokens: 0,
          maxImagesPerRequest: 3,
          whenUnsupported: 'omit',
          remoteUrls: false,
        },
        { vision: { images: true, toolResultImages: true, mediaTypes: ['image/png'] } },
      ),
    ).toEqual({
      store,
      maxImageBytes: 1024,
      maxImagesPerInput: 2,
      historyTokens: 0,
      maxImagesPerRequest: 3,
      whenUnsupported: 'omit',
      remoteUrls: false,
      mediaTypes: ['image/png'],
    });
  });

  it('rejects invalid limits', () => {
    expect(() => assertImagePolicy({ maxImageBytes: 0 })).toThrow(ConfigError);
    expect(() => assertImagePolicy({ maxImagesPerRequest: 1.5 })).toThrow(ConfigError);
    expect(() => assertImagePolicy({ historyTokens: -1 })).toThrow(ConfigError);
    expect(() => assertImagePolicy({ historyTokens: 0 })).not.toThrow();
    expect(() => assertImagePolicy(undefined)).not.toThrow();
  });
});
```

创建 `src/images/__tests__/normalizeImages.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import type { ModelContent, ModelImageContent } from '../../model/message.js';
import type { VisionCapability } from '../../model/vision.js';
import { type ResolvedImagePolicy, resolveImagePolicy } from '../ImagePolicy.js';
import { InMemoryImageStore } from '../InMemoryImageStore.js';
import { normalizeImageContent } from '../normalizeImages.js';
import { dataUrl, ONE_PIXEL_PNG_BASE64, ONE_PIXEL_PNG_DATA_URL, pngBytes } from './fixtures.js';

const vision: VisionCapability = { images: true, toolResultImages: false, imageTokens: 1600 };
const blind: VisionCapability = { images: false, toolResultImages: false };

function policy(overrides: Partial<ResolvedImagePolicy> = {}): ResolvedImagePolicy {
  return { ...resolveImagePolicy(undefined, { vision }), ...overrides };
}

const image = (url: string): ModelContent => ({ type: 'image_url', image_url: { url } });

describe('normalizeImageContent', () => {
  it('returns strings and text-only content untouched', async () => {
    const content: ModelContent[] = [{ type: 'text', text: 'hi' }];
    expect(await normalizeImageContent('hi', { policy: policy(), vision })).toBe('hi');
    expect(await normalizeImageContent(content, { policy: policy(), vision })).toBe(content);
  });

  it('adds metadata to inline images when there is no store', async () => {
    const result = await normalizeImageContent(
      [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL, detail: 'low', alt: 'dot' } },
      ],
      { policy: policy(), vision },
    );

    expect(result).toEqual([
      { type: 'text', text: 'look' },
      {
        type: 'image_url',
        image_url: {
          url: ONE_PIXEL_PNG_DATA_URL,
          detail: 'low',
          alt: 'dot',
          mediaType: 'image/png',
          width: 1,
          height: 1,
          byteLength: 70,
        },
      },
    ]);
  });

  it('moves inline images into the store and keeps only the reference', async () => {
    const store = new InMemoryImageStore();
    const [part] = (await normalizeImageContent(
      [{ type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL, alt: 'dot' } }],
      { policy: policy({ store }), vision },
    )) as ModelImageContent[];

    expect(part).toEqual({
      type: 'image_url',
      image_url: {
        url: expect.stringMatching(/^blade-image:sha256:[0-9a-f]{64}$/),
        alt: 'dot',
        mediaType: 'image/png',
        width: 1,
        height: 1,
        byteLength: 70,
      },
    });
    expect(await store.get(part?.image_url.url ?? '')).toMatchObject({ mediaType: 'image/png' });
  });

  it.each([
    ['svg data', `data:image/svg+xml;base64,${btoa('<svg/>')}`, 'media_type'],
    ['a non-base64 data URL', 'data:image/png,not-base64', 'media_type'],
    ['a declared type that is not the real one', `data:image/jpeg;base64,${ONE_PIXEL_PNG_BASE64}`, 'media_type'],
    ['an unknown scheme', 'lark-image:img_v3_abc', 'unresolvable'],
    ['a store reference without a store', `blade-image:sha256:${'e'.repeat(64)}`, 'unresolvable'],
  ])('rejects %s', async (_name, url, reason) => {
    await expect(
      normalizeImageContent([{ type: 'text', text: 'x' }, image(url)], { policy: policy(), vision }),
    ).rejects.toMatchObject({ index: 1, reason });
  });

  it('rejects images over the byte limit before decoding them', async () => {
    const url = dataUrl('image/png', pngBytes(10, 10, 2048));
    await expect(
      normalizeImageContent([image(url)], { policy: policy({ maxImageBytes: 1024 }), vision }),
    ).rejects.toMatchObject({ index: 0, reason: 'too_large' });
  });

  it('rejects too many images, and remote URLs when they are not allowed', async () => {
    const three = [image(ONE_PIXEL_PNG_DATA_URL), image(ONE_PIXEL_PNG_DATA_URL), image(ONE_PIXEL_PNG_DATA_URL)];
    await expect(
      normalizeImageContent(three, { policy: policy({ maxImagesPerInput: 2 }), vision }),
    ).rejects.toMatchObject({ index: 2, reason: 'too_many' });

    const remote = [image('https://example.test/a.png')];
    await expect(
      normalizeImageContent(remote, { policy: policy({ remoteUrls: false }), vision }),
    ).rejects.toMatchObject({ index: 0, reason: 'remote_url' });
    expect(await normalizeImageContent(remote, { policy: policy(), vision })).toEqual(remote);
  });

  it('rejects or keeps images for a model without vision according to the policy', async () => {
    const content = [image(ONE_PIXEL_PNG_DATA_URL)];
    await expect(
      normalizeImageContent(content, { policy: policy(), vision: blind }),
    ).rejects.toMatchObject({ index: 0, reason: 'unsupported_model' });
    expect(
      await normalizeImageContent(content, {
        policy: policy({ whenUnsupported: 'omit' }),
        vision: blind,
      }),
    ).toMatchObject([{ image_url: { mediaType: 'image/png' } }]);
  });
});
```

创建 `src/images/__tests__/ImageRuntime.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../errors/ConfigError.js';
import { SessionInputError } from '../../errors/SessionInputError.js';
import { ImageRuntime } from '../ImageRuntime.js';

describe('ImageRuntime', () => {
  it('follows the bound model and uses the fallback before binding', () => {
    const runtime = new ImageRuntime({
      fallbackVision: () => ({ images: false, toolResultImages: false }),
    });
    expect(runtime.vision().images).toBe(false);

    let accepts = true;
    runtime.bindModel({
      getVision: () => ({ images: accepts, toolResultImages: true, imageTokens: 1600 }),
      getInputWindowTokens: () => 24_000,
      markImagesUnsupported: () => {
        accepts = false;
      },
    });
    expect(runtime.vision().images).toBe(true);
    expect(runtime.policy().historyTokens).toBe(6_000);

    runtime.markImagesUnsupported();
    expect(runtime.vision().images).toBe(false);
  });

  it('wraps rejections in SessionInputError', async () => {
    const runtime = new ImageRuntime({ policy: { remoteUrls: false } });
    const rejected = runtime.normalizeUserContent([
      { type: 'image_url', image_url: { url: 'https://example.test/a.png' } },
    ]);

    await expect(rejected).rejects.toBeInstanceOf(SessionInputError);
    await expect(rejected).rejects.toMatchObject({
      code: 'SESSION_INPUT_IMAGE_REJECTED',
      details: { index: 0, reason: 'remote_url' },
    });
  });

  it('rejects an invalid policy at construction', () => {
    expect(() => new ImageRuntime({ policy: { maxImagesPerRequest: 0 } })).toThrow(ConfigError);
  });
});
```

创建 `src/session/__tests__/SessionImages.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { SessionInputError } from '../../errors/SessionInputError.js';
import { ONE_PIXEL_PNG_DATA_URL } from '../../images/__tests__/fixtures.js';
import { InMemoryImageStore } from '../../images/InMemoryImageStore.js';
import type { ModelServiceConfig } from '../../model/config.js';
import type { ModelContent, ModelMessage } from '../../model/message.js';
import type { ModelService } from '../../model/service.js';
import { ProviderRegistry } from '../../services/ProviderRegistry.js';
import { createSession } from '../Session.js';
import type { ISession, SessionOptions } from '../types.js';

function captureRegistry(requests: ModelMessage[][]): ProviderRegistry {
  return new ProviderRegistry([
    {
      type: 'image-capture-api',
      create(config: Readonly<ModelServiceConfig>): ModelService {
        let current: ModelServiceConfig = { ...config };
        return {
          async chat(messages) {
            requests.push([...messages]);
            return { content: 'ok' };
          },
          async sideQuery() {
            return { content: 'ok' };
          },
          async *streamChat(messages) {
            requests.push([...messages]);
            yield { content: 'ok' };
            yield { finishReason: 'stop' };
          },
          getConfig: () => current,
          updateConfig(next) {
            current = { ...current, ...next };
          },
        };
      },
    },
  ]);
}

function sessionOptions(
  requests: ModelMessage[][],
  overrides: Partial<SessionOptions> = {},
): SessionOptions {
  return {
    provider: { type: 'image-capture-api', apiKey: 'test-key' },
    providerRegistry: captureRegistry(requests),
    model: 'capture-model',
    persistSession: false,
    allowedTools: [],
    ...overrides,
  };
}

async function drain(session: ISession): Promise<void> {
  for await (const _event of session.stream()) {
    // Drain the request to completion.
  }
}

function imagePart(message: ModelMessage | undefined): ModelContent | undefined {
  return Array.isArray(message?.content)
    ? message.content.find((part) => part.type === 'image_url')
    : undefined;
}

describe('Session images', () => {
  it('stores inline images and keeps only the reference in the transcript', async () => {
    const requests: ModelMessage[][] = [];
    const store = new InMemoryImageStore();
    const session = await createSession(sessionOptions(requests, { images: { store } }));

    await session.send([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } },
    ]);
    await drain(session);

    const stored = imagePart(session.messages.find((message) => message.role === 'user'));
    expect(stored).toEqual({
      type: 'image_url',
      image_url: {
        url: expect.stringMatching(/^blade-image:sha256:[0-9a-f]{64}$/),
        mediaType: 'image/png',
        width: 1,
        height: 1,
        byteLength: 70,
      },
    });
    expect(JSON.stringify(session.messages)).not.toContain(';base64,');
    if (stored?.type === 'image_url') {
      expect(await store.get(stored.image_url.url)).toMatchObject({ mediaType: 'image/png' });
    }

    await session.close();
  });

  it('rejects images the current model cannot accept', async () => {
    const requests: ModelMessage[][] = [];
    const session = await createSession(sessionOptions(requests, { vision: { images: false } }));

    const sent = session.send([{ type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } }]);

    await expect(sent).rejects.toBeInstanceOf(SessionInputError);
    await expect(sent).rejects.toMatchObject({
      code: 'SESSION_INPUT_IMAGE_REJECTED',
      details: { index: 0, reason: 'unsupported_model' },
    });
    expect(requests).toEqual([]);

    await session.close();
  });
});
```

在 `src/session/__tests__/SessionModelConfig.test.ts` 顶部加 `import { ImageRuntime } from '../../images/ImageRuntime.js';`，在 `describe` 末尾追加：

```ts
  it('hands the Session image runtime to the Agent', async () => {
    const session = await createSession({
      provider: { type: 'openai-compatible', apiKey: 'test-key' },
      model: 'qwen-vl-max',
    });

    const [, , deps] = createAgent.mock.calls.at(-1) ?? [];
    expect(deps).toMatchObject({ imageRuntime: expect.any(ImageRuntime) });

    await session.close();
  });
```

`src/session/__tests__/SessionContext.test.ts` 的 `should preserve image parts when UserPromptSubmit hooks rewrite multimodal text` 用例改为使用真实图片：

1. 顶部加 `import { ONE_PIXEL_PNG_DATA_URL } from '../../images/__tests__/fixtures.js';`。
2. `session.send` 中的 `{ type: 'image_url', image_url: { url: 'data:image/png;base64,hook' } }` 改为 `{ type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } }`。
3. 期望值里的图片 part 改为：

```ts
      {
        type: 'image_url',
        image_url: {
          url: ONE_PIXEL_PNG_DATA_URL,
          mediaType: 'image/png',
          width: 1,
          height: 1,
          byteLength: 70,
        },
      },
```

原来的 `data:image/png;base64,hook` 不是真实图片，规范化之后会被拒绝；而真实图片会被补上元数据，所以期望值要一起改。

- [ ] **Step 2: 确认测试失败**

Run: `pnpm vitest run src/images/__tests__/ImagePolicy.test.ts src/images/__tests__/normalizeImages.test.ts src/images/__tests__/ImageRuntime.test.ts src/session/__tests__/SessionImages.test.ts src/session/__tests__/SessionModelConfig.test.ts src/session/__tests__/SessionContext.test.ts`
Expected: FAIL：
- 新模块不存在；
- Session 用例里 transcript 仍是 data URL，`vision: { images: false }` 时 `send()` 没有报错；
- `deps` 中没有 `imageRuntime`；
- SessionContext 的期望值缺少元数据。

- [ ] **Step 3: SessionInputError 增加 details**

把 `src/errors/SessionInputError.ts` 整个替换为：

```ts
import { SdkError, type SdkErrorOptions } from './SdkError.js';

export type SessionInputErrorCode =
  | 'SESSION_INPUT_QUEUE_FULL'
  | 'SESSION_REQUEST_MISMATCH'
  | 'SESSION_STEERING_UNAVAILABLE'
  | 'SESSION_INPUT_OPTIONS_UNSUPPORTED'
  | 'SESSION_INPUT_IMAGE_REJECTED';

/** Why `send()` refused an image part. */
export type ImageRejectionReason =
  | 'unsupported_model'
  | 'too_large'
  | 'too_many'
  | 'media_type'
  | 'remote_url'
  | 'unresolvable';

export interface SessionInputErrorDetails {
  /** Position of the rejected part in the submitted content array. */
  readonly index: number;
  readonly reason: ImageRejectionReason;
}

export interface SessionInputErrorOptions extends SdkErrorOptions {
  readonly details?: SessionInputErrorDetails;
}

export class SessionInputError extends SdkError {
  readonly details?: SessionInputErrorDetails;

  constructor(code: string, message: string, options?: SessionInputErrorOptions) {
    super(code, message, options);
    if (options?.details) this.details = options.details;
  }

  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), ...(this.details ? { details: this.details } : {}) };
  }
}
```

`src/errors/index.ts` 把 `export type { SessionInputErrorCode } from './SessionInputError.js';` 改为：

```ts
export type {
  ImageRejectionReason,
  SessionInputErrorCode,
  SessionInputErrorDetails,
} from './SessionInputError.js';
```

`src/index.ts` 的 `export type { ... } from './errors/index.js';` 块中加入 `ImageRejectionReason` 和 `SessionInputErrorDetails`。

- [ ] **Step 4: ImagePolicy 的默认值与解析**

在 `src/images/ImagePolicy.ts` 顶部加入：

```ts
import { ConfigError } from '../errors/ConfigError.js';
import type { VisionCapability } from '../model/vision.js';
import { IMAGE_MEDIA_TYPES } from './imageBytes.js';
```

并在 `ImagePolicy` 接口之后追加：

```ts
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_IMAGES_PER_INPUT = 20;
export const DEFAULT_MAX_IMAGES_PER_REQUEST = 50;
export const DEFAULT_HISTORY_IMAGE_TOKENS = 16_000;
/** Input window assumed before a model is applied: 128k context minus 8,192 output tokens. */
const DEFAULT_INPUT_WINDOW_TOKENS = 128_000 - 8_192;

/** An `ImagePolicy` with every default filled in for the active model. */
export interface ResolvedImagePolicy {
  readonly store?: ImageStore;
  readonly maxImageBytes: number;
  readonly maxImagesPerInput: number;
  readonly historyTokens: number;
  readonly maxImagesPerRequest: number;
  readonly whenUnsupported: 'reject' | 'omit';
  readonly remoteUrls: boolean;
  readonly mediaTypes: readonly string[];
}

export function assertImagePolicy(policy: ImagePolicy | undefined): void {
  const limits = [
    ['maxImageBytes', policy?.maxImageBytes, 1],
    ['maxImagesPerInput', policy?.maxImagesPerInput, 1],
    ['historyTokens', policy?.historyTokens, 0],
    ['maxImagesPerRequest', policy?.maxImagesPerRequest, 1],
  ] as const;
  for (const [name, value, minimum] of limits) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
      throw new ConfigError(`images.${name} must be a safe integer of at least ${minimum}`);
    }
  }
}

export function resolveImagePolicy(
  policy: ImagePolicy | undefined,
  context: { readonly vision: VisionCapability; readonly inputWindowTokens?: number },
): ResolvedImagePolicy {
  const inputWindow = Math.max(0, context.inputWindowTokens ?? DEFAULT_INPUT_WINDOW_TOKENS);
  return {
    store: policy?.store,
    maxImageBytes: Math.min(
      policy?.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      context.vision.maxImageBytes ?? Number.POSITIVE_INFINITY,
    ),
    maxImagesPerInput: policy?.maxImagesPerInput ?? DEFAULT_MAX_IMAGES_PER_INPUT,
    historyTokens:
      policy?.historyTokens ??
      Math.min(DEFAULT_HISTORY_IMAGE_TOKENS, Math.floor(inputWindow * 0.25)),
    maxImagesPerRequest:
      policy?.maxImagesPerRequest ??
      context.vision.maxImagesPerRequest ??
      DEFAULT_MAX_IMAGES_PER_REQUEST,
    whenUnsupported: policy?.whenUnsupported ?? 'reject',
    remoteUrls: policy?.remoteUrls ?? true,
    mediaTypes: context.vision.mediaTypes ?? IMAGE_MEDIA_TYPES,
  };
}
```

- [ ] **Step 5: 入口规范化**

创建 `src/images/normalizeImages.ts`：

```ts
import type { ImageRejectionReason } from '../errors/SessionInputError.js';
import type { ImageRef } from '../model/image.js';
import type { ModelContent } from '../model/message.js';
import type { VisionCapability } from '../model/vision.js';
import { type Base64DataUrl, base64DecodedLength, base64ToBytes, parseBase64DataUrl } from './base64.js';
import { inspectImageBytes } from './imageBytes.js';
import type { ResolvedImagePolicy } from './ImagePolicy.js';

/** An image part `send()` refuses; `index` is its position in the content array. */
export class ImageRejection extends Error {
  constructor(
    readonly index: number,
    readonly reason: ImageRejectionReason,
    message: string,
  ) {
    super(message);
    this.name = 'ImageRejection';
  }
}

export interface NormalizeImagesContext {
  readonly policy: ResolvedImagePolicy;
  readonly vision: VisionCapability;
  readonly signal?: AbortSignal;
}

const REMOTE_URL = /^https?:\/\//i;

const canonicalMediaType = (mediaType: string) =>
  mediaType === 'image/jpg' ? 'image/jpeg' : mediaType;

async function admitInlineImage(
  ref: ImageRef,
  inline: Base64DataUrl,
  index: number,
  context: NormalizeImagesContext,
): Promise<ImageRef> {
  const { policy } = context;
  const tooLarge = () =>
    new ImageRejection(index, 'too_large', `Images must be at most ${policy.maxImageBytes} bytes`);
  if (base64DecodedLength(inline.base64) > policy.maxImageBytes) throw tooLarge();
  const bytes = base64ToBytes(inline.base64);
  if (bytes.byteLength > policy.maxImageBytes) throw tooLarge();

  const facts = inspectImageBytes(bytes);
  const declared = [inline.mediaType, ref.mediaType?.toLowerCase() ?? '']
    .filter((type) => type !== '')
    .map(canonicalMediaType);
  if (
    !facts ||
    !policy.mediaTypes.includes(facts.mediaType) ||
    declared.some((type) => type !== facts.mediaType)
  ) {
    throw new ImageRejection(index, 'media_type', 'Only png, jpeg, gif and webp images are accepted');
  }

  const metadata: Partial<ImageRef> = {
    mediaType: facts.mediaType,
    byteLength: facts.byteLength,
    ...(facts.width !== undefined && facts.height !== undefined
      ? { width: facts.width, height: facts.height }
      : {}),
  };
  if (!policy.store) return { ...ref, ...metadata };
  const stored = await policy.store.put({ bytes, mediaType: facts.mediaType }, context.signal);
  return { ...ref, ...metadata, url: stored.url };
}

async function admitImage(
  ref: ImageRef,
  index: number,
  context: NormalizeImagesContext,
): Promise<ImageRef> {
  const inline = parseBase64DataUrl(ref.url);
  if (inline) return admitInlineImage(ref, inline, index, context);
  if (ref.url.startsWith('data:')) {
    throw new ImageRejection(index, 'media_type', 'Inline images must be base64 png, jpeg, gif or webp data');
  }
  if (REMOTE_URL.test(ref.url)) {
    if (!context.policy.remoteUrls) {
      throw new ImageRejection(index, 'remote_url', 'Remote image URLs are not accepted');
    }
    return ref;
  }
  if (context.policy.store?.handles(ref.url)) return ref;
  throw new ImageRejection(index, 'unresolvable', 'No image store resolves this image reference');
}

/**
 * Admit the images of one input: check count, capability, size and real media
 * type, add metadata, and move inline bytes into the store when one is
 * configured. Content without images is returned as is.
 */
export async function normalizeImageContent(
  content: string | ModelContent[],
  context: NormalizeImagesContext,
): Promise<string | ModelContent[]> {
  if (typeof content === 'string') return content;
  const imageIndexes = content.flatMap((part, index) => (part.type === 'image_url' ? [index] : []));
  if (imageIndexes.length === 0) return content;

  const { policy, vision } = context;
  if (imageIndexes.length > policy.maxImagesPerInput) {
    throw new ImageRejection(
      imageIndexes[policy.maxImagesPerInput] ?? 0,
      'too_many',
      `At most ${policy.maxImagesPerInput} images are accepted in one input`,
    );
  }
  if (!vision.images && policy.whenUnsupported === 'reject') {
    throw new ImageRejection(
      imageIndexes[0] ?? 0,
      'unsupported_model',
      'The current model does not accept images',
    );
  }

  const normalized: ModelContent[] = [];
  for (const [index, part] of content.entries()) {
    context.signal?.throwIfAborted();
    normalized.push(
      part.type === 'image_url'
        ? { type: 'image_url', image_url: await admitImage(part.image_url, index, context) }
        : part,
    );
  }
  return normalized;
}
```

- [ ] **Step 6: ImageRuntime**

创建 `src/images/ImageRuntime.ts`：

```ts
import { SessionInputError } from '../errors/SessionInputError.js';
import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import type { ModelContent } from '../model/message.js';
import type { VisionCapability } from '../model/vision.js';
import {
  assertImagePolicy,
  type ImagePolicy,
  type ResolvedImagePolicy,
  resolveImagePolicy,
} from './ImagePolicy.js';
import { ImageRejection, normalizeImageContent } from './normalizeImages.js';
import { DEFAULT_VISION_CAPABILITY } from './visionDefaults.js';

/** What the Agent tells the image runtime about its active model. */
export interface ImageModelBinding {
  readonly getVision: () => VisionCapability | undefined;
  readonly getInputWindowTokens: () => number | undefined;
  readonly markImagesUnsupported: () => void;
}

export interface ImageRuntimeOptions {
  readonly policy?: ImagePolicy;
  /** Capability used until a model binding reports one. */
  readonly fallbackVision?: () => VisionCapability;
  readonly logger?: InternalLogger;
}

/**
 * Session-scoped image handling: admits images when they arrive and projects
 * them into each model request. The transcript is never rewritten.
 */
export class ImageRuntime {
  private binding?: ImageModelBinding;
  private readonly logger: InternalLogger;

  constructor(private readonly options: ImageRuntimeOptions = {}) {
    assertImagePolicy(options.policy);
    this.logger = (options.logger ?? NOOP_LOGGER).child(LogCategory.CONTEXT);
  }

  bindModel(binding: ImageModelBinding): void {
    this.binding = binding;
  }

  vision(): VisionCapability {
    return (
      this.binding?.getVision() ?? this.options.fallbackVision?.() ?? DEFAULT_VISION_CAPABILITY
    );
  }

  policy(): ResolvedImagePolicy {
    return resolveImagePolicy(this.options.policy, {
      vision: this.vision(),
      inputWindowTokens: this.binding?.getInputWindowTokens(),
    });
  }

  /** Admit the images of one user input; a refused image throws `SessionInputError`. */
  async normalizeUserContent(
    content: string | ModelContent[],
    signal?: AbortSignal,
  ): Promise<string | ModelContent[]> {
    try {
      return await normalizeImageContent(content, {
        policy: this.policy(),
        vision: this.vision(),
        signal,
      });
    } catch (error) {
      if (error instanceof ImageRejection) {
        this.logger.debug(`[Images] Rejected input image ${error.index}: ${error.reason}`);
        throw new SessionInputError('SESSION_INPUT_IMAGE_REJECTED', error.message, {
          cause: error,
          details: { index: error.index, reason: error.reason },
        });
      }
      throw error;
    }
  }

  markImagesUnsupported(): void {
    this.binding?.markImagesUnsupported();
  }
}
```

- [ ] **Step 7: 接到 Session 与 Agent**

`src/session/SessionRuntime.ts`：
1. import 区加 `import { ImageRuntime } from '../images/ImageRuntime.js';` 和 `import { resolveVisionCapability } from '../images/visionDefaults.js';`。
2. 字段区（`private readonly usesBuiltinTools: boolean;` 附近）加 `private readonly imageRuntime: ImageRuntime;`。
3. 构造函数中 `this.logger = logger.child(LogCategory.AGENT);` 之后加：

```ts
    this.imageRuntime = new ImageRuntime({
      policy: options.images,
      fallbackVision: () =>
        resolveVisionCapability({
          provider: options.provider.type,
          model: options.model,
          sessionOverride: options.vision,
        }),
      logger,
    });
```

4. 在 `getAgentRuntimeDeps()` 返回对象的 `hookRuntime: this.hookRuntime,` 之后加 `imageRuntime: this.imageRuntime,`。在 `getHookRuntime()` 之后加：

```ts
  getImageRuntime(): ImageRuntime {
    return this.imageRuntime;
  }
```

`src/agent/Agent.ts`：
1. import 区加 `import { ImageRuntime } from '../images/ImageRuntime.js';`。
2. `AgentRuntimeDeps` 里 `hookRuntime?: HookRuntime;` 之后加 `imageRuntime?: ImageRuntime;`。
3. 字段区加 `private readonly imageRuntime: ImageRuntime;`。
4. 构造函数中 `this.modelManager = new ModelManager(...);` 语句之后加：

```ts
    this.imageRuntime = deps.imageRuntime ?? new ImageRuntime({ logger: this.rootLogger });
    this.imageRuntime.bindModel({
      getVision: () => this.modelManager.getVision(),
      getInputWindowTokens: () => this.modelManager.getInputWindowTokens(),
      markImagesUnsupported: () => this.modelManager.markImagesUnsupported(),
    });
```

`src/session/SessionRequestCoordinator.ts`：把 `send` 的开头：

```ts
  async send(message: UserMessageContent, options?: SendOptions): Promise<InputSubmission> {
    await this.ensureInitialized();

    return this.state.inputMutex.runExclusive(async () => {
```

改为：

```ts
  async send(submitted: UserMessageContent, options?: SendOptions): Promise<InputSubmission> {
    await this.ensureInitialized();
    const message = await this.state
      .getRuntime()
      .getImageRuntime()
      .normalizeUserContent(submitted, options?.signal);

    return this.state.inputMutex.runExclusive(async () => {
```

方法体其余部分不变：后面用的都是规范化之后的 `message`。规范化放在获取 input mutex 之前，所以 durable `recordAccepted` 和 `saveInputEnqueued` 记录的已经是规范化结果。

- [ ] **Step 8: 确认通过**

Run: `pnpm vitest run src/images src/session src/agent src/__tests__/rootExports.test.ts`
Expected: 全部通过。

- [ ] **Step 9: 提交**

```bash
pnpm lint:fix && pnpm type-check
git add src/errors src/index.ts src/images src/session/SessionRuntime.ts src/agent/Agent.ts src/session/SessionRequestCoordinator.ts src/session/__tests__/SessionImages.test.ts src/session/__tests__/SessionModelConfig.test.ts src/session/__tests__/SessionContext.test.ts
git commit -m "feat(images): admit and store images when a Session receives input"
```

---
### Task 9: 输入错误映射为协议错误

**Files:**
- Modify: `src/server/SessionExecutor.ts`
- Test: `src/server/__tests__/SessionExecutorInputErrors.test.ts`
- Modify (test): `src/server/__tests__/AgentServer.integration.test.ts`
- Create: `.changes/protocol-input-errors.json`

**Interfaces:**
- Consumes：Task 8 的 `SessionInputError.details`。
- Produces：`toProtocolInputError(error: unknown): unknown`（从 `src/server/SessionExecutor.ts` 导出，仅供测试使用，不进任何包入口）。

- [ ] **Step 1: 写失败测试**

创建 `src/server/__tests__/SessionExecutorInputErrors.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { SessionInputError } from '../../errors/SessionInputError.js';
import { AgentProtocolError } from '../../protocol/index.js';
import { toProtocolInputError } from '../SessionExecutor.js';

describe('toProtocolInputError', () => {
  it.each([
    ['SESSION_INPUT_IMAGE_REJECTED', 'INVALID_COMMAND', 400, false],
    ['SESSION_INPUT_OPTIONS_UNSUPPORTED', 'INVALID_COMMAND', 400, false],
    ['SESSION_REQUEST_MISMATCH', 'SESSION_CONFLICT', 409, false],
    ['SESSION_STEERING_UNAVAILABLE', 'SESSION_CONFLICT', 409, false],
    ['SESSION_INPUT_QUEUE_FULL', 'OVERLOADED', 503, true],
  ] as const)('maps %s', (code, protocolCode, status, retryable) => {
    const mapped = toProtocolInputError(new SessionInputError(code, 'refused'));
    expect(mapped).toBeInstanceOf(AgentProtocolError);
    expect(mapped).toMatchObject({ protocolCode, status, retryable, message: 'refused' });
  });

  it('keeps image rejection details and leaves other errors alone', () => {
    const rejected = new SessionInputError('SESSION_INPUT_IMAGE_REJECTED', 'bad image', {
      details: { index: 2, reason: 'media_type' },
    });
    expect(toProtocolInputError(rejected)).toMatchObject({
      details: { index: 2, reason: 'media_type' },
    });

    const other = new Error('boom');
    expect(toProtocolInputError(other)).toBe(other);
  });
});
```

在 `src/server/__tests__/AgentServer.integration.test.ts` 的 `describe('AgentServer', ...)` 中追加（顶部 import 加入 `import type { ModelContent } from '../../model/message.js';`）：

```ts
  it('reports a rejected image as an invalid command that must not be retried', async () => {
    const { server } = createTestServer();
    const sessionId = await createSession(server);

    const result = await server.execute(
      command(AgentCommandType.INPUT_SUBMIT, 'submit-svg', {
        sessionId,
        input: [
          {
            type: 'image_url',
            image_url: { url: `data:image/svg+xml;base64,${btoa('<svg/>')}` },
          },
        ] satisfies ModelContent[],
      }),
      principal,
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_COMMAND',
        retryable: false,
        details: { index: 0, reason: 'media_type' },
      },
    });
    await server.close();
  });
```

- [ ] **Step 2: 确认测试失败**

Run: `pnpm vitest run src/server/__tests__/SessionExecutorInputErrors.test.ts src/server/__tests__/AgentServer.integration.test.ts`
Expected: FAIL：`toProtocolInputError` 没有导出；集成用例的结果是 `INTERNAL_ERROR` 且 `retryable: true`。

- [ ] **Step 3: 实现**

`src/server/SessionExecutor.ts`：
1. import 区加 `import { SessionInputError } from '../errors/SessionInputError.js';`。确认 `AgentProtocolError` 已经从 `../protocol/index.js` 导入（文件里已有用法）。
2. 在第一个 `export interface` 之前加：

```ts
/** Turn input refusals into protocol errors that tell clients whether retrying can help. */
export function toProtocolInputError(error: unknown): unknown {
  if (!(error instanceof SessionInputError)) return error;
  const options = { cause: error };
  switch (error.code) {
    case 'SESSION_INPUT_IMAGE_REJECTED':
      return new AgentProtocolError(
        'INVALID_COMMAND',
        error.message,
        400,
        false,
        undefined,
        error.details ? { index: error.details.index, reason: error.details.reason } : undefined,
        options,
      );
    case 'SESSION_INPUT_OPTIONS_UNSUPPORTED':
      return new AgentProtocolError('INVALID_COMMAND', error.message, 400, false, undefined, undefined, options);
    case 'SESSION_REQUEST_MISMATCH':
    case 'SESSION_STEERING_UNAVAILABLE':
      return new AgentProtocolError('SESSION_CONFLICT', error.message, 409, false, undefined, undefined, options);
    case 'SESSION_INPUT_QUEUE_FULL':
      return new AgentProtocolError('OVERLOADED', error.message, 503, true, 1_000, undefined, options);
    default:
      return error;
  }
}
```

3. `InProcessSessionExecutor.submit` 里的：

```ts
      const submission = await managed.session.send(data.input, {
        priority: data.priority,
        expectedRequestId: data.expectedRequestId,
        maxTurns: data.maxTurns,
      });
```

改为：

```ts
      const submission = await managed.session
        .send(data.input, {
          priority: data.priority,
          expectedRequestId: data.expectedRequestId,
          maxTurns: data.maxTurns,
        })
        .catch((error: unknown) => {
          throw toProtocolInputError(error);
        });
```

- [ ] **Step 4: 加 changelog fragment**

创建 `.changes/protocol-input-errors.json`：

```json
{
  "type": "fix",
  "en": "AgentServer now answers refused input with `INVALID_COMMAND`, `SESSION_CONFLICT` or `OVERLOADED` instead of a retryable `INTERNAL_ERROR`, so clients stop retrying input that cannot succeed. Rejected images carry `details.index` and `details.reason`.",
  "zh-CN": "AgentServer 现在用 `INVALID_COMMAND`、`SESSION_CONFLICT` 或 `OVERLOADED` 回应被拒绝的输入，不再返回可重试的 `INTERNAL_ERROR`，客户端不会再重试注定失败的输入。被拒绝的图片会带上 `details.index` 和 `details.reason`。"
}
```

- [ ] **Step 5: 确认通过**

Run: `pnpm vitest run src/server && pnpm changelog:check`
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
pnpm lint:fix && pnpm type-check
git add src/server/SessionExecutor.ts src/server/__tests__/SessionExecutorInputErrors.test.ts src/server/__tests__/AgentServer.integration.test.ts .changes/protocol-input-errors.json
git commit -m "fix(server): report refused input as non-retryable protocol errors"
```

---

### Task 10: 预算选择（纯函数）

**Files:**
- Create: `src/images/imageBudget.ts`
- Test: `src/images/__tests__/imageBudget.test.ts`

**Interfaces:**
- Produces：
  - `ImageSlot { readonly cost: number; readonly fresh: boolean }`
  - `ImageSelectionLimits { readonly maxImages: number; readonly historyTokens: number; readonly maxFreshImages?: number }`
  - `selectImages(slots: readonly ImageSlot[], limits: ImageSelectionLimits): boolean[]`：返回值与输入一一对应，`true` 表示保留。

- [ ] **Step 1: 写失败测试**

创建 `src/images/__tests__/imageBudget.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { type ImageSlot, selectImages } from '../imageBudget.js';

const history = (count: number, cost = 1_600): ImageSlot[] =>
  Array.from({ length: count }, () => ({ cost, fresh: false }));
const fresh = (count: number, cost = 1_600): ImageSlot[] =>
  Array.from({ length: count }, () => ({ cost, fresh: true }));

describe('selectImages', () => {
  it('keeps everything within the allowance', () => {
    expect(selectImages(history(3), { maxImages: 50, historyTokens: 16_000 })).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('keeps fresh images first, newest first, under the hard cap', () => {
    expect(
      selectImages([...history(2), ...fresh(3)], { maxImages: 2, historyTokens: 16_000 }),
    ).toEqual([false, false, false, true, true]);
  });

  it('caps fresh images for recovery retries', () => {
    expect(
      selectImages(fresh(4, 1), { maxImages: 50, historyTokens: 0, maxFreshImages: 2 }),
    ).toEqual([false, false, true, true]);
  });

  it('omits every history image when the allowance is zero', () => {
    expect(selectImages(history(3), { maxImages: 50, historyTokens: 0 })).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('moves the history cut in steps of half the allowance', () => {
    const cuts = Array.from({ length: 60 }, (_, index) =>
      selectImages(history(index + 1), { maxImages: 50, historyTokens: 16_000 }).indexOf(true),
    );

    // Ten screenshots fit. The 11th moves the cut by five and it then holds for four more.
    expect(cuts.slice(0, 10)).toEqual(new Array(10).fill(0));
    expect(cuts.slice(10, 15)).toEqual(new Array(5).fill(5));
    expect(cuts.slice(15, 20)).toEqual(new Array(5).fill(10));
    for (const [index, cut] of cuts.entries()) {
      expect(cut % 5).toBe(0);
      expect((index + 1 - cut) * 1_600).toBeLessThanOrEqual(16_000);
    }
  });

  it('moves the count cut in steps of half the remaining places', () => {
    const cut = (count: number) =>
      selectImages(history(count, 1), { maxImages: 4, historyTokens: 16_000 }).indexOf(true);
    expect([4, 5, 6, 7, 8].map(cut)).toEqual([0, 2, 2, 4, 4]);
  });
});
```

- [ ] **Step 2: 确认测试失败**

Run: `pnpm vitest run src/images/__tests__/imageBudget.test.ts`
Expected: FAIL，`imageBudget.js` 不存在。

- [ ] **Step 3: 实现**

创建 `src/images/imageBudget.ts`：

```ts
/** One image part of a request, in conversation order. */
export interface ImageSlot {
  /** Estimated token cost of sending the image. */
  readonly cost: number;
  /** The model has not seen the image yet: it follows the last assistant message. */
  readonly fresh: boolean;
}

export interface ImageSelectionLimits {
  /** Hard cap on images in the request. */
  readonly maxImages: number;
  /** Token allowance shared by history images. */
  readonly historyTokens: number;
  /** Optional cap on fresh images, used by recovery retries. */
  readonly maxFreshImages?: number;
}

/** How many of the oldest history images to omit so the rest fits the allowance. */
function tokenCut(costs: readonly number[], allowance: number): number {
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  if (total <= allowance) return 0;
  if (allowance <= 0) return costs.length;
  // Round the excess up to half the allowance so the cut, and the prompt prefix
  // in front of it, stays put while new images arrive.
  const step = allowance / 2;
  const target = Math.ceil((total - allowance) / step) * step;
  let omitted = 0;
  let cut = 0;
  while (cut < costs.length && omitted < target) {
    omitted += costs[cut];
    cut += 1;
  }
  return cut;
}

function countCut(count: number, places: number): number {
  if (count <= places) return 0;
  if (places <= 0) return count;
  const step = Math.max(1, Math.floor(places / 2));
  return Math.min(count, Math.ceil((count - places) / step) * step);
}

/**
 * Decide which images a request keeps. Fresh images take places first, newest
 * first. History images keep the newest suffix that fits both the token
 * allowance and the remaining places.
 */
export function selectImages(
  slots: readonly ImageSlot[],
  limits: ImageSelectionLimits,
): boolean[] {
  const keep = slots.map(() => false);
  const freshIndexes = slots.flatMap((slot, index) => (slot.fresh ? [index] : []));
  const historyIndexes = slots.flatMap((slot, index) => (slot.fresh ? [] : [index]));

  const freshPlaces = Math.max(
    0,
    Math.min(limits.maxImages, limits.maxFreshImages ?? Number.POSITIVE_INFINITY),
  );
  const keptFresh = freshIndexes.slice(Math.max(0, freshIndexes.length - freshPlaces));
  for (const index of keptFresh) keep[index] = true;

  const historyPlaces = Math.max(0, limits.maxImages - keptFresh.length);
  const cut = Math.max(
    tokenCut(
      historyIndexes.map((index) => slots[index].cost),
      limits.historyTokens,
    ),
    countCut(historyIndexes.length, historyPlaces),
  );
  for (const index of historyIndexes.slice(cut)) keep[index] = true;
  return keep;
}
```

- [ ] **Step 4: 确认通过**

Run: `pnpm vitest run src/images/__tests__/imageBudget.test.ts`
Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
pnpm lint:fix && pnpm type-check
git add src/images/imageBudget.ts src/images/__tests__/imageBudget.test.ts
git commit -m "feat(images): select request images with a stable history cut"
```

---

### Task 11: 请求投影与引用解析

**Files:**
- Create: `src/images/prepareImagesForRequest.ts`
- Modify: `src/images/ImageRuntime.ts`（`prepareRequest`）
- Test: `src/images/__tests__/prepareImagesForRequest.test.ts`
- Modify (test): `src/images/__tests__/ImageRuntime.test.ts`

**Interfaces:**
- Consumes：
  - Task 10 的 `selectImages`
  - Task 6 的 `imagePlaceholder`、`ImageOmissionReason`
  - Task 5 的 `estimateImageTokens`
  - Task 8 的 `ResolvedImagePolicy`、`ImageRuntime`
  - Task 2 的 `toDataUrl`
- Produces：
  - `ImageRequestLimits { readonly historyTokens?: number; readonly maxFreshImages?: number }`
  - `ImageProjectionReport { readonly total; readonly kept; readonly freshKept; readonly omitted: Readonly<Record<ImageOmissionReason, number>>; readonly estimatedTokens }`
  - `PreparedImageRequest { readonly messages: readonly ModelMessage[]; readonly report: ImageProjectionReport }`
  - `ResolvedImageCache { get(key: string): string | undefined; set(key: string, value: string): unknown }`
  - `prepareImagesForRequest(messages: readonly ModelMessage[], context: { vision; policy: ResolvedImagePolicy; cache?: ResolvedImageCache; limits?: ImageRequestLimits; signal?; logger? }): Promise<PreparedImageRequest>`
  - `ImageRuntime.prepareRequest(messages, options?: { limits?: ImageRequestLimits; signal?: AbortSignal }): Promise<PreparedImageRequest>`

- [ ] **Step 1: 写失败测试**

创建 `src/images/__tests__/prepareImagesForRequest.test.ts`：

```ts
import { LRUCache } from 'lru-cache';
import { describe, expect, it, vi } from 'vitest';
import type { ImageRef } from '../../model/image.js';
import type { ModelContent, ModelMessage } from '../../model/message.js';
import type { VisionCapability } from '../../model/vision.js';
import { base64ToBytes } from '../base64.js';
import { resolveImagePolicy } from '../ImagePolicy.js';
import type { ImageStore } from '../ImageStore.js';
import { InMemoryImageStore } from '../InMemoryImageStore.js';
import { prepareImagesForRequest } from '../prepareImagesForRequest.js';
import { ONE_PIXEL_PNG_BASE64, ONE_PIXEL_PNG_DATA_URL } from './fixtures.js';

const vision: VisionCapability = { images: true, toolResultImages: true, imageTokens: 1600 };
const basePolicy = resolveImagePolicy(undefined, { vision, inputWindowTokens: 120_000 });
const image = (extra: Partial<ImageRef> = {}): ModelContent => ({
  type: 'image_url',
  image_url: { url: ONE_PIXEL_PNG_DATA_URL, mediaType: 'image/png', width: 1, height: 1, ...extra },
});
const unavailable = { type: 'text', text: '[image unavailable: it is no longer in the image store]' };

describe('prepareImagesForRequest', () => {
  it('returns the same array when no message carries an image', async () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'hi' }];
    const prepared = await prepareImagesForRequest(messages, { vision, policy: basePolicy });
    expect(prepared.messages).toBe(messages);
    expect(prepared.report.total).toBe(0);
  });

  it('replaces every image with a placeholder for a model without vision', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'see' }, image({ alt: 'dot' })] },
    ];
    const prepared = await prepareImagesForRequest(messages, {
      vision: { images: false, toolResultImages: false },
      policy: basePolicy,
    });

    expect(prepared.messages[0]?.content).toEqual([
      { type: 'text', text: 'see' },
      {
        type: 'text',
        text: '[image omitted: the current model does not accept images — image/png 1×1 — dot]',
      },
    ]);
    expect(prepared.report).toMatchObject({ total: 1, kept: 0, omitted: { unsupported: 1 } });
    expect(messages[0]?.content).toEqual([{ type: 'text', text: 'see' }, image({ alt: 'dot' })]);
  });

  it('keeps fresh images and drops the oldest history images past the allowance', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: [image({ alt: 'old' })] },
      { role: 'assistant', content: 'noted' },
      { role: 'user', content: [image({ alt: 'mid' })] },
      { role: 'assistant', content: 'noted' },
      { role: 'user', content: [image({ alt: 'new' })] },
    ];
    const prepared = await prepareImagesForRequest(messages, {
      vision,
      policy: { ...basePolicy, historyTokens: 1_600 },
    });

    expect(prepared.messages[0]?.content).toEqual([
      { type: 'text', text: '[image omitted to fit the image budget: image/png 1×1 — old]' },
    ]);
    expect(prepared.messages[2]).toBe(messages[2]);
    expect(prepared.messages[4]).toBe(messages[4]);
    expect(prepared.report).toMatchObject({
      total: 3,
      kept: 2,
      freshKept: 1,
      omitted: { budget: 1, unsupported: 0, unavailable: 0 },
      estimatedTokens: 3_200,
    });
  });

  it('applies recovery limits', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: [image()] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [image(), image()] },
    ];
    const prepared = await prepareImagesForRequest(messages, {
      vision,
      policy: basePolicy,
      limits: { historyTokens: 0, maxFreshImages: 1 },
    });

    expect(prepared.report).toMatchObject({ kept: 1, freshKept: 1, omitted: { budget: 2 } });
    expect(prepared.messages[2]?.content).toEqual([
      { type: 'text', text: '[image omitted to fit the image budget: image/png 1×1]' },
      image(),
    ]);
  });

  it('replaces images in system and assistant messages', async () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: [image()] },
      { role: 'assistant', content: [image()] },
      { role: 'user', content: 'next' },
    ];
    const prepared = await prepareImagesForRequest(messages, { vision, policy: basePolicy });
    expect(prepared.report).toMatchObject({ total: 2, kept: 0, omitted: { unsupported: 2 } });
  });

  it('resolves store references and caches the bytes', async () => {
    const store = new InMemoryImageStore();
    const ref = await store.put({
      bytes: base64ToBytes(ONE_PIXEL_PNG_BASE64),
      mediaType: 'image/png',
    });
    const get = vi.spyOn(store, 'get');
    const cache = new LRUCache<string, string>({
      maxSize: 1024 * 1024,
      sizeCalculation: (value) => value.length,
    });
    const messages: ModelMessage[] = [{ role: 'user', content: [{ type: 'image_url', image_url: ref }] }];

    const first = await prepareImagesForRequest(messages, {
      vision,
      policy: { ...basePolicy, store },
      cache,
    });
    await prepareImagesForRequest(messages, { vision, policy: { ...basePolicy, store }, cache });

    expect(first.messages[0]?.content).toEqual([
      { type: 'image_url', image_url: { ...ref, url: ONE_PIXEL_PNG_DATA_URL } },
    ]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('passes a presigned URL from the store straight to the request', async () => {
    const store: ImageStore = {
      handles: (url) => url.startsWith('s3://'),
      put: async () => {
        throw new Error('unused');
      },
      get: async () => ({ url: 'https://bucket.example.test/a.png?sig=1' }),
    };
    const prepared = await prepareImagesForRequest(
      [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 's3://bucket/a.png', mediaType: 'image/png' } }],
        },
      ],
      { vision, policy: { ...basePolicy, store } },
    );

    expect(prepared.messages[0]?.content).toEqual([
      {
        type: 'image_url',
        image_url: { url: 'https://bucket.example.test/a.png?sig=1', mediaType: 'image/png' },
      },
    ]);
  });

  it('turns missing, failing and unknown references into placeholders', async () => {
    const store: ImageStore = {
      handles: (url) => url.startsWith('app-image:'),
      put: async () => {
        throw new Error('unused');
      },
      get: async (url) => {
        if (url === 'app-image:broken') throw new Error('disk failure');
        return undefined;
      },
    };
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'app-image:gone' } },
          { type: 'image_url', image_url: { url: 'app-image:broken' } },
          { type: 'image_url', image_url: { url: 'other:unknown' } },
        ],
      },
    ];
    const prepared = await prepareImagesForRequest(messages, {
      vision,
      policy: { ...basePolicy, store },
    });

    expect(prepared.messages[0]?.content).toEqual([unavailable, unavailable, unavailable]);
    expect(prepared.report.omitted.unavailable).toBe(3);
  });
});
```

在 `src/images/__tests__/ImageRuntime.test.ts` 的 `describe` 中追加（顶部 import 加入 `import { InMemoryImageStore } from '../InMemoryImageStore.js';` 和 `import { ONE_PIXEL_PNG_DATA_URL } from './fixtures.js';`）：

```ts
  it('admits an image into its store and resolves it again for a request', async () => {
    const runtime = new ImageRuntime({ policy: { store: new InMemoryImageStore() } });
    const content = await runtime.normalizeUserContent([
      { type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } },
    ]);
    const prepared = await runtime.prepareRequest([{ role: 'user', content }]);

    expect(JSON.stringify(content)).not.toContain(';base64,');
    expect(prepared.messages[0]?.content).toEqual([
      {
        type: 'image_url',
        image_url: {
          url: ONE_PIXEL_PNG_DATA_URL,
          mediaType: 'image/png',
          width: 1,
          height: 1,
          byteLength: 70,
        },
      },
    ]);
  });
```

- [ ] **Step 2: 确认测试失败**

Run: `pnpm vitest run src/images/__tests__/prepareImagesForRequest.test.ts src/images/__tests__/ImageRuntime.test.ts`
Expected: FAIL：`prepareImagesForRequest.js` 不存在，`runtime.prepareRequest is not a function`。

- [ ] **Step 3: 实现投影**

创建 `src/images/prepareImagesForRequest.ts`：

```ts
import type { InternalLogger } from '../logging/Logger.js';
import type { ImageRef } from '../model/image.js';
import type { ModelContent, ModelMessage } from '../model/message.js';
import type { VisionCapability } from '../model/vision.js';
import { toDataUrl } from './base64.js';
import { estimateImageTokens } from './estimateImageTokens.js';
import { selectImages } from './imageBudget.js';
import type { ResolvedImagePolicy } from './ImagePolicy.js';
import { type ImageOmissionReason, imagePlaceholder } from './imageText.js';

/** Tighter limits for one recovery retry. */
export interface ImageRequestLimits {
  /** Replaces the history allowance; 0 omits every image the model has already seen. */
  readonly historyTokens?: number;
  /** Caps how many fresh images survive. */
  readonly maxFreshImages?: number;
}

export interface ImageProjectionReport {
  readonly total: number;
  readonly kept: number;
  readonly freshKept: number;
  readonly omitted: Readonly<Record<ImageOmissionReason, number>>;
  readonly estimatedTokens: number;
}

export interface PreparedImageRequest {
  readonly messages: readonly ModelMessage[];
  readonly report: ImageProjectionReport;
}

/** Store references already turned into data URLs; an `LRUCache<string, string>` fits. */
export interface ResolvedImageCache {
  get(key: string): string | undefined;
  set(key: string, value: string): unknown;
}

export interface ImageRequestContext {
  readonly vision: VisionCapability;
  readonly policy: ResolvedImagePolicy;
  readonly cache?: ResolvedImageCache;
  readonly limits?: ImageRequestLimits;
  readonly signal?: AbortSignal;
  readonly logger?: InternalLogger;
}

interface LocatedImage {
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly ref: ImageRef;
  /** Only user and tool messages may carry images to a provider. */
  readonly eligible: boolean;
  readonly fresh: boolean;
}

type Decision = ImageOmissionReason | 'keep';

const REMOTE_URL = /^https?:\/\//i;
const NO_IMAGES: ImageProjectionReport = {
  total: 0,
  kept: 0,
  freshKept: 0,
  omitted: { budget: 0, unsupported: 0, unavailable: 0 },
  estimatedTokens: 0,
};

function locateImages(messages: readonly ModelMessage[]): LocatedImage[] {
  const lastAssistant = messages.findLastIndex((message) => message.role === 'assistant');
  return messages.flatMap((message, messageIndex) =>
    typeof message.content === 'string'
      ? []
      : message.content.flatMap((part, partIndex) =>
          part.type === 'image_url'
            ? [
                {
                  messageIndex,
                  partIndex,
                  ref: part.image_url,
                  eligible: message.role === 'user' || message.role === 'tool',
                  fresh: messageIndex > lastAssistant,
                },
              ]
            : [],
        ),
  );
}

function decide(images: readonly LocatedImage[], context: ImageRequestContext): Decision[] {
  const decisions: Decision[] = images.map((image) => (image.eligible ? 'keep' : 'unsupported'));
  const eligible = images.flatMap((image, index) => (image.eligible ? [index] : []));
  if (!context.vision.images) {
    for (const index of eligible) decisions[index] = 'unsupported';
    return decisions;
  }
  const keep = selectImages(
    eligible.map((index) => ({
      cost: estimateImageTokens(images[index].ref, context.vision),
      fresh: images[index].fresh,
    })),
    {
      maxImages: context.policy.maxImagesPerRequest,
      historyTokens: context.limits?.historyTokens ?? context.policy.historyTokens,
      maxFreshImages: context.limits?.maxFreshImages,
    },
  );
  eligible.forEach((imageIndex, slot) => {
    if (!keep[slot]) decisions[imageIndex] = 'budget';
  });
  return decisions;
}

/** The ref as the provider should receive it, or undefined when its bytes are gone. */
async function resolveImage(
  ref: ImageRef,
  context: ImageRequestContext,
): Promise<ImageRef | undefined> {
  if (ref.url.startsWith('data:') || REMOTE_URL.test(ref.url)) return ref;
  const store = context.policy.store;
  if (!store?.handles(ref.url)) return undefined;
  const cached = context.cache?.get(ref.url);
  if (cached !== undefined) return { ...ref, url: cached };
  try {
    const resolved = await store.get(ref.url, context.signal);
    if (!resolved) return undefined;
    if ('url' in resolved) return { ...ref, url: resolved.url };
    const url = toDataUrl(resolved.mediaType, resolved.bytes);
    context.cache?.set(ref.url, url);
    return { ...ref, url };
  } catch (error) {
    context.signal?.throwIfAborted();
    context.logger?.warn(`[Images] Could not resolve ${ref.url}:`, error);
    return undefined;
  }
}

function rebuild(
  messages: readonly ModelMessage[],
  replacements: ReadonlyMap<string, ModelContent>,
): readonly ModelMessage[] {
  return messages.map((message, messageIndex) => {
    if (typeof message.content === 'string') return message;
    let changed = false;
    const content = message.content.map((part, partIndex) => {
      const replacement = replacements.get(`${messageIndex}:${partIndex}`);
      if (!replacement) return part;
      changed = true;
      return replacement;
    });
    return changed ? { ...message, content } : message;
  });
}

/**
 * Build the image view of one model request: keep what the capability and the
 * budget allow, resolve store references, and put deterministic placeholders
 * where images were left out. The input messages are never modified.
 */
export async function prepareImagesForRequest(
  messages: readonly ModelMessage[],
  context: ImageRequestContext,
): Promise<PreparedImageRequest> {
  const images = locateImages(messages);
  if (images.length === 0) return { messages, report: NO_IMAGES };

  const decisions = decide(images, context);
  const replacements = new Map<string, ModelContent>();
  const omitted: Record<ImageOmissionReason, number> = { budget: 0, unsupported: 0, unavailable: 0 };
  let kept = 0;
  let freshKept = 0;
  let estimatedTokens = 0;
  for (const [index, image] of images.entries()) {
    const key = `${image.messageIndex}:${image.partIndex}`;
    let decision = decisions[index] ?? 'unsupported';
    if (decision === 'keep') {
      const resolved = await resolveImage(image.ref, context);
      if (resolved) {
        kept += 1;
        if (image.fresh) freshKept += 1;
        estimatedTokens += estimateImageTokens(image.ref, context.vision);
        if (resolved !== image.ref) replacements.set(key, { type: 'image_url', image_url: resolved });
        continue;
      }
      decision = 'unavailable';
    }
    omitted[decision] += 1;
    replacements.set(key, { type: 'text', text: imagePlaceholder(decision, image.ref) });
  }

  return {
    messages: rebuild(messages, replacements),
    report: { total: images.length, kept, freshKept, omitted, estimatedTokens },
  };
}
```

- [ ] **Step 4: ImageRuntime.prepareRequest**

`src/images/ImageRuntime.ts`：

1. import 区加：

```ts
import { LRUCache } from 'lru-cache';
import type { ModelContent, ModelMessage } from '../model/message.js';
import {
  type ImageRequestLimits,
  type PreparedImageRequest,
  prepareImagesForRequest,
} from './prepareImagesForRequest.js';
```

同时删掉原来的 `import type { ModelContent } from '../model/message.js';`。

2. 在 `ImageRuntimeOptions` 之前加 `const RESOLVED_IMAGE_CACHE_CHARS = 64 * 1024 * 1024;`。

3. 类的字段区加：

```ts
  private readonly resolved = new LRUCache<string, string>({
    maxSize: RESOLVED_IMAGE_CACHE_CHARS,
    sizeCalculation: (value) => Math.max(1, value.length),
  });
```

4. 在 `normalizeUserContent` 之后加：

```ts
  /** The image view of one model request; see `prepareImagesForRequest`. */
  async prepareRequest(
    messages: readonly ModelMessage[],
    options: { readonly limits?: ImageRequestLimits; readonly signal?: AbortSignal } = {},
  ): Promise<PreparedImageRequest> {
    const prepared = await prepareImagesForRequest(messages, {
      vision: this.vision(),
      policy: this.policy(),
      cache: this.resolved,
      limits: options.limits,
      signal: options.signal,
      logger: this.logger,
    });
    const { omitted } = prepared.report;
    if (omitted.budget + omitted.unsupported + omitted.unavailable > 0) {
      this.logger.debug('[Images] Images left out of the model request:', prepared.report);
    }
    return prepared;
  }
```

- [ ] **Step 5: 确认通过**

Run: `pnpm vitest run src/images`
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
pnpm lint:fix && pnpm type-check
git add src/images
git commit -m "feat(images): project images into each model request within the budget"
```

---
### Task 12: 在每轮请求前投影

**Files:**
- Modify: `src/agent/state/TurnState.ts`
- Modify: `src/agent/state/LoopState.ts`
- Modify: `src/agent/LoopRunner.ts`
- Modify: `src/agent/Agent.ts`（把 `imageRuntime` 交给 LoopRunner）
- Modify: `src/agent/loop/runTurn.ts`
- Modify: `src/agent/AgentEvent.ts`
- Modify: `src/session/StreamBroadcaster.ts`
- Modify: `src/services/modelAdapter.ts`
- Test: `src/services/__tests__/modelAdapter.images.test.ts`
- Modify (test): `src/agent/__tests__/AgentLoop.test.ts`、`src/session/__tests__/StreamBroadcaster.test.ts`、`src/session/__tests__/SessionImages.test.ts`

**Interfaces:**
- Consumes：Task 11 的 `ImageRuntime.prepareRequest`、`ImageProjectionReport`、`ImageRequestLimits`。
- Produces：
  - `TurnState.images?: ImageRuntime`
  - `RunTurnInput.imageLimits?: ImageRequestLimits`
  - `RunTurnInput.onImageProjection?: (report: ImageProjectionReport) => void`
  - 内部事件 `AgentEvent`：`{ type: 'image_projection'; turn: number; report: ImageProjectionReport }`，只记录进 trace，不进入对外的 `SessionStreamEvent`。

- [ ] **Step 1: 写失败测试**

在 `src/agent/__tests__/AgentLoop.test.ts` 顶部加入：

```ts
import { ONE_PIXEL_PNG_DATA_URL } from '../../images/__tests__/fixtures.js';
import { ImageRuntime } from '../../images/ImageRuntime.js';
```

并在 `describe('agentLoop', ...)` 里追加：

```ts
  describe('image projection', () => {
    it('sends the projected request and reports the projection', async () => {
      const images = new ImageRuntime();
      images.bindModel({
        getVision: () => ({ images: false, toolResultImages: false }),
        getInputWindowTokens: () => 120_000,
        markImagesUnsupported: () => {},
      });
      const modelService = createMockModelService([{ content: 'done' }]);

      const { events } = await collectEvents(
        agentLoop(
          baseConfig({
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'look' },
                  { type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } },
                ],
              },
            ],
            turnState: { modelService, images },
          }),
        ),
      );

      const sent = (modelService.chat as Mock).mock.calls[0]?.[0] as ModelMessage[];
      expect(sent.at(-1)?.content).toEqual([
        { type: 'text', text: 'look' },
        { type: 'text', text: '[image omitted: the current model does not accept images]' },
      ]);
      expect(events).toContainEqual({
        type: 'image_projection',
        turn: 1,
        report: expect.objectContaining({ total: 1, kept: 0 }),
      });
    });
  });
```

在 `src/session/__tests__/StreamBroadcaster.test.ts` 顶部加入 `import { TraceRecorder } from '../../observability/TraceRecorder.js';`，在 `describe('StreamBroadcaster', ...)` 里追加：

```ts
  it('records image projections in the turn span without streaming them', () => {
    const recorder = new TraceRecorder(sessionId, { enabled: true, capturePayloads: true });
    const broadcaster = new StreamBroadcaster({ sessionId, traceRecorder: recorder });
    broadcaster.project({ type: 'turn_start', turn: 1, maxTurns: 5 });
    const report = {
      total: 2,
      kept: 1,
      freshKept: 1,
      omitted: { budget: 1, unsupported: 0, unavailable: 0 },
      estimatedTokens: 1600,
    };

    expect(broadcaster.project({ type: 'image_projection', turn: 1, report })).toBeNull();

    const trace = recorder.getTrace();
    const event = trace.events.find((entry) => entry.type === 'image_projection');
    expect(event?.spanId).toBe(trace.spans.find((span) => span.kind === 'turn')?.id);
  });
```

创建 `src/services/__tests__/modelAdapter.images.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { ONE_PIXEL_PNG_BASE64, ONE_PIXEL_PNG_DATA_URL } from '../../images/__tests__/fixtures.js';
import { NOOP_LOGGER } from '../../logging/Logger.js';
import { prepareModelRequest } from '../modelAdapter.js';

describe('prepareModelRequest images', () => {
  it('maps image detail to the OpenAI provider option and keeps the media type', () => {
    const prepared = prepareModelRequest(
      { provider: 'openai', model: 'gpt-5', apiKey: 'test-key', baseUrl: '' },
      NOOP_LOGGER,
      [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL, detail: 'low' } },
            {
              type: 'image_url',
              image_url: { url: 'https://example.test/a.webp', mediaType: 'image/webp' },
            },
          ],
        },
      ],
    );

    expect(prepared.coreMessages[0]).toEqual({
      role: 'user',
      content: [
        {
          type: 'image',
          image: ONE_PIXEL_PNG_BASE64,
          mediaType: 'image/png',
          providerOptions: { openai: { imageDetail: 'low' } },
        },
        { type: 'image', image: 'https://example.test/a.webp', mediaType: 'image/webp' },
      ],
    });
  });
});
```

在 `src/session/__tests__/SessionImages.test.ts` 的 `describe('Session images', ...)` 里追加：

```ts
  it('sends the stored image to the model as data while the transcript keeps the reference', async () => {
    const requests: ModelMessage[][] = [];
    const session = await createSession(
      sessionOptions(requests, { images: { store: new InMemoryImageStore() } }),
    );

    await session.send([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } },
    ]);
    await drain(session);

    const sent = imagePart(requests.at(-1)?.findLast((message) => message.role === 'user'));
    expect(sent).toEqual({
      type: 'image_url',
      image_url: {
        url: ONE_PIXEL_PNG_DATA_URL,
        mediaType: 'image/png',
        width: 1,
        height: 1,
        byteLength: 70,
      },
    });

    await session.close();
  });

  it('sends a placeholder when the model cannot see images and the policy keeps them', async () => {
    const requests: ModelMessage[][] = [];
    const session = await createSession(
      sessionOptions(requests, { vision: { images: false }, images: { whenUnsupported: 'omit' } }),
    );

    await session.send([
      { type: 'text', text: 'here' },
      { type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL, alt: 'dot' } },
    ]);
    await drain(session);

    expect(requests.at(-1)?.findLast((message) => message.role === 'user')?.content).toEqual([
      { type: 'text', text: 'here' },
      {
        type: 'text',
        text: '[image omitted: the current model does not accept images — image/png 1×1 — dot]',
      },
    ]);
    expect(imagePart(session.messages.find((message) => message.role === 'user'))).toMatchObject({
      type: 'image_url',
    });

    await session.close();
  });
```

- [ ] **Step 2: 确认测试失败**

Run: `pnpm vitest run src/agent/__tests__/AgentLoop.test.ts src/session/__tests__/StreamBroadcaster.test.ts src/services/__tests__/modelAdapter.images.test.ts src/session/__tests__/SessionImages.test.ts`
Expected: FAIL：
- `pnpm type-check` 报 `images` 不在 `TurnState` 上，`image_projection` 不是合法的 `AgentEvent`；
- 运行时，模型收到的仍是原始图片；
- adapter 用例缺少 `providerOptions` 和 webp 的 `mediaType`；
- Session 用例收到的是 `blade-image:` 引用。

- [ ] **Step 3: 把 ImageRuntime 交给每一轮**

`src/agent/state/TurnState.ts`：import 区加 `import type { ImageRuntime } from '../../images/ImageRuntime.js';`，在 `TurnState` 的 `activeSkill?: LoopSkillState;` 之后加：

```ts
  /** Projects images into this turn's model request; absent in bare loops and tests. */
  images?: ImageRuntime;
```

`src/agent/state/LoopState.ts`：
- import 区加 `import type { ImageRuntime } from '../../images/ImageRuntime.js';`。
- `LoopStateOptions` 加 `images?: ImageRuntime;`。
- 类的字段区加 `private readonly images?: ImageRuntime;`。
- 构造函数里加 `this.images = options.images;`。
- `buildTurnState` 返回对象的 `activeSkill: this.activeSkill,` 之后加 `images: this.images,`。

`src/agent/LoopRunner.ts`：
- import 区加 `import type { ImageRuntime } from '../images/ImageRuntime.js';`。
- 构造函数参数列表在 `private skillRegistry?: SkillRegistry,` 之后加 `private imageRuntime?: ImageRuntime,`。
- `createLoopState` 里 `new LoopState({` 的参数对象，在 `initialActiveSkill: rpm.skillContext,` 之后加 `images: this.imageRuntime,`。

`src/agent/Agent.ts`：`initialize()` 里的 `new LoopRunner(...)` 参数列表在 `this.skillRegistry,` 之后加 `this.imageRuntime,`。

- [ ] **Step 4: runTurn 在请求前投影**

`src/agent/AgentEvent.ts`：import 区加 `import type { ImageProjectionReport } from '../images/prepareImagesForRequest.js';`，在 `AgentEvent` 联合里 `| { type: 'model_fallback'; ... }` 之前加：

```ts
  | { type: 'image_projection'; turn: number; report: ImageProjectionReport }
```

`src/agent/loop/runTurn.ts`：
1. import 区加 `import type { ImageProjectionReport, ImageRequestLimits } from '../../images/prepareImagesForRequest.js';`。
2. `RunTurnInput` 在 `logger?: InternalLogger;` 之后加：

```ts
  /** Tighter image limits for a recovery retry. */
  imageLimits?: ImageRequestLimits;
  /** Receives the image projection of the request about to be sent. */
  onImageProjection?: (report: ImageProjectionReport) => void;
```

3. 在 `requestModel` 之前加：

```ts
async function* projectImages(input: RunTurnInput): AsyncGenerator<AgentEvent, RunTurnInput> {
  const images = input.turnState.images;
  if (!images) return input;
  const prepared = await images.prepareRequest(input.messages, {
    limits: input.imageLimits,
    signal: input.signal,
  });
  if (prepared.report.total > 0) {
    input.onImageProjection?.(prepared.report);
    yield { type: 'image_projection', turn: input.turnState.turn, report: prepared.report };
  }
  return prepared.messages === input.messages ? input : { ...input, messages: prepared.messages };
}
```

4. `runTurn` 里在 `const tools = ...` 语句之后加 `const request = yield* projectImages(input);`，并把 `const chatResponse = yield* requestModel(input, tools);` 改为 `const chatResponse = yield* requestModel(request, tools);`。

投影放在 `onModelRequestStarting` 之前：读取 store 失败或被中止时，durable journal 里不会留下一条没有结果的模型请求。

`src/session/StreamBroadcaster.ts`：在 `project()` 的 `switch` 里 `case 'token_usage':` 之前加：

```ts
      case 'image_projection':
        traceRecorder?.addEvent('image_projection', { ...event.report }, this.turnSpans.get(event.turn));
        return null;
```

- [ ] **Step 5: 适配层映射 detail 与 mediaType**

`src/services/modelAdapter.ts`：
1. 把 `AIMessage` 中 user content 的图片成员 `| { type: 'image'; image: string; mediaType?: string }` 改为：

```ts
            | {
                type: 'image';
                image: string;
                mediaType?: string;
                providerOptions?: AIProviderOptions;
              }
```

2. 在 `convertMessages` 的 user 分支里，把：

```ts
                const data = parseDataUrl(part.image_url.url);
                return {
                  type: 'image',
                  image: data?.data ?? part.image_url.url,
                  ...(data?.mediaType ? { mediaType: data.mediaType } : {}),
                };
```

改为：

```ts
                const data = parseDataUrl(part.image_url.url);
                const mediaType = data?.mediaType ?? part.image_url.mediaType;
                return {
                  type: 'image',
                  image: data?.data ?? part.image_url.url,
                  ...(mediaType ? { mediaType } : {}),
                  ...(part.image_url.detail
                    ? { providerOptions: { openai: { imageDetail: part.image_url.detail } } }
                    : {}),
                };
```

- [ ] **Step 6: 确认通过**

Run: `pnpm vitest run src/agent src/session src/services src/images`
Expected: 全部通过。

- [ ] **Step 7: 提交**

```bash
pnpm lint:fix && pnpm type-check
git add src/agent src/session/StreamBroadcaster.ts src/services/modelAdapter.ts src/services/__tests__/modelAdapter.images.test.ts src/session/__tests__/StreamBroadcaster.test.ts src/session/__tests__/SessionImages.test.ts
git commit -m "feat(images): project images into every model request of the agent loop"
```

---

### Task 13: 图片错误恢复

**Files:**
- Create: `src/images/imageErrors.ts`
- Modify: `src/agent/AgentLoop.ts`
- Modify: `src/agent/AgentEvent.ts`
- Modify: `src/agent/LoopHookBuilder.ts`
- Test: `src/images/__tests__/imageErrors.test.ts`
- Modify (test): `src/agent/__tests__/AgentLoop.test.ts`

**Interfaces:**
- Consumes：Task 12 的 `RunTurnInput.imageLimits`、`onImageProjection`；Task 4 的 `ModelManager.markImagesUnsupported()`。
- Produces：
  - `ImageLimitKind = 'too_many' | 'too_large' | 'invalid' | 'unsupported'`
  - `classifyImageLimitError(error: unknown): ImageLimitKind | undefined`
  - `AgentLoopHooks.recovery.onImagesUnsupported?: () => void | Promise<void>`
  - `turn_retry` 和 `recovery` 事件新增 reason `'image_limit'`

- [ ] **Step 1: 写失败测试**

创建 `src/images/__tests__/imageErrors.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { CannotRetryError } from '../../services/RetryPolicy.js';
import { classifyImageLimitError } from '../imageErrors.js';

describe('classifyImageLimitError', () => {
  it.each([
    ['Too many images in request. Max is 500.', 'too_many'],
    ['At most 1 image(s) may be provided in one request.', 'too_many'],
    [
      'messages.0.content.1.image.source.base64: image exceeds 5 MB maximum: 6291456 bytes > 5242880 bytes',
      'too_large',
    ],
    ['Invalid image.', 'invalid'],
    ['Invalid content type. image_url is only supported by certain models.', 'unsupported'],
    [
      'Failed to deserialize the JSON body into the target type: messages[0]: unknown variant `image_url`, expected `text`',
      'unsupported',
    ],
    ['The model does not support image input', 'unsupported'],
  ] as const)('classifies %s', (message, kind) => {
    expect(classifyImageLimitError(new Error(message))).toBe(kind);
  });

  it('follows causes and retry wrappers', () => {
    expect(
      classifyImageLimitError(
        new Error('request failed', { cause: new Error('Too many images in request') }),
      ),
    ).toBe('too_many');
    expect(classifyImageLimitError(new CannotRetryError(new Error('Invalid image'), {}))).toBe(
      'invalid',
    );
  });

  it('ignores unrelated errors', () => {
    expect(classifyImageLimitError(new Error('maximum context length exceeded'))).toBeUndefined();
    expect(classifyImageLimitError('rate limited')).toBeUndefined();
  });
});
```

在 `src/agent/__tests__/AgentLoop.test.ts` 里：

1. 顶部 import 改为 `import type { ModelContent, ModelMessage } from '../../model/message.js';`（加入 `ModelContent`）。
2. `BaseConfigOverrides` 在 `onReactiveCompact?: ...;` 之后加：

```ts
  onImagesUnsupported?: NonNullable<
    NonNullable<AgentLoopConfig['hooks']>['recovery']
  >['onImagesUnsupported'];
```

3. `baseConfig` 的解构里加入 `onImagesUnsupported,`，并把 `recovery: { reactiveCompact: onReactiveCompact }` 改为 `recovery: { reactiveCompact: onReactiveCompact, onImagesUnsupported }`。
4. 在 `describe('agentLoop', ...)` 里追加：

```ts
  describe('image limit recovery', () => {
    function boundImages() {
      const images = new ImageRuntime();
      let accepts = true;
      images.bindModel({
        getVision: () => ({ images: accepts, toolResultImages: true, imageTokens: 1600 }),
        getInputWindowTokens: () => 120_000,
        markImagesUnsupported: () => {
          accepts = false;
        },
      });
      return images;
    }

    const twoImages: ModelMessage = {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } },
        { type: 'image_url', image_url: { url: ONE_PIXEL_PNG_DATA_URL } },
      ],
    };

    function serviceRejecting(error: Error, times = 1) {
      const chat = vi.fn();
      for (let attempt = 0; attempt < times; attempt += 1) chat.mockRejectedValueOnce(error);
      chat.mockResolvedValue({
        content: 'recovered',
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      });
      const modelService = {
        chat,
        chatWithRetryEvents: vi.fn(async function* (...args: Parameters<typeof chat>) {
          yield* [] as never[];
          return await chat(...args);
        }),
        getConfig: () => ({ model: 'test-model', maxContextTokens: 128000 }),
      } as unknown as TurnState['modelService'];
      return { chat, modelService };
    }

    const sentImages = (call: unknown[] | undefined) =>
      ((call?.[0] as ModelMessage[]).at(-1)?.content as ModelContent[]).filter(
        (part) => part.type === 'image_url',
      );

    it('retries once with half the fresh images after a too-many-images error', async () => {
      const { chat, modelService } = serviceRejecting(
        new Error('At most 1 image(s) may be provided in one request.'),
      );

      const { events, result } = await collectEvents(
        agentLoop(baseConfig({ messages: [twoImages], turnState: { modelService, images: boundImages() } })),
      );

      expect(result.success).toBe(true);
      expect(chat).toHaveBeenCalledTimes(2);
      expect(sentImages(chat.mock.calls[0])).toHaveLength(2);
      expect(sentImages(chat.mock.calls[1])).toHaveLength(1);
      expect(events).toContainEqual({ type: 'turn_retry', turn: 1, reason: 'image_limit' });
    });

    it('stops sending images once the provider says the model does not accept them', async () => {
      const images = boundImages();
      const onImagesUnsupported = vi.fn(() => images.markImagesUnsupported());
      const { chat, modelService } = serviceRejecting(
        new Error('Invalid content type. image_url is only supported by certain models.'),
      );

      const { result } = await collectEvents(
        agentLoop(
          baseConfig({ messages: [twoImages], turnState: { modelService, images }, onImagesUnsupported }),
        ),
      );

      expect(result.success).toBe(true);
      expect(onImagesUnsupported).toHaveBeenCalledTimes(1);
      expect(sentImages(chat.mock.calls[1])).toEqual([]);
    });

    it('does not retry an image error when the request carried no images', async () => {
      const { chat, modelService } = serviceRejecting(new Error('Too many images in request'));

      await expect(
        collectEvents(agentLoop(baseConfig({ turnState: { modelService, images: boundImages() } }))),
      ).rejects.toThrow('Too many images');
      expect(chat).toHaveBeenCalledTimes(1);
    });

    it('surfaces the error when the retry fails again', async () => {
      const { chat, modelService } = serviceRejecting(new Error('Too many images in request'), 2);

      await expect(
        collectEvents(
          agentLoop(baseConfig({ messages: [twoImages], turnState: { modelService, images: boundImages() } })),
        ),
      ).rejects.toThrow('Too many images');
      expect(chat).toHaveBeenCalledTimes(2);
    });
  });
```

- [ ] **Step 2: 确认测试失败**

Run: `pnpm vitest run src/images/__tests__/imageErrors.test.ts src/agent/__tests__/AgentLoop.test.ts`
Expected: FAIL：`imageErrors.js` 不存在；`onImagesUnsupported` 不是合法的 hook（类型错误）；图片错误直接抛出，没有重试。

- [ ] **Step 3: 识别图片错误**

创建 `src/images/imageErrors.ts`：

```ts
import { CannotRetryError } from '../services/RetryPolicy.js';

/** Why a provider refused a request because of its images. */
export type ImageLimitKind = 'too_many' | 'too_large' | 'invalid' | 'unsupported';

// Provider wording collected from OpenAI, Anthropic, vLLM and DeepSeek responses.
const IMAGE_ERROR_PATTERNS: ReadonlyArray<readonly [ImageLimitKind, RegExp]> = [
  [
    'unsupported',
    /does not support image|image input is not supported|image_url is only supported|unknown variant `?image_url|images? (?:are|is) not supported/i,
  ],
  ['too_many', /too many images|at most \d+ image|maximum number of images/i],
  ['too_large', /image (?:is )?too large|image exceeds|exceeds \d+(?:\.\d+)? ?mb/i],
  ['invalid', /invalid image|could not process image|unable to process (?:the )?image|failed to decode image/i],
];

function messageOf(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  return typeof value === 'string' ? value : undefined;
}

/** Follows causes and retry wrappers, like `isOverflowRecoverable`. */
export function classifyImageLimitError(error: unknown): ImageLimitKind | undefined {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const message = messageOf(current);
    if (message) {
      for (const [kind, pattern] of IMAGE_ERROR_PATTERNS) {
        if (pattern.test(message)) return kind;
      }
    }
    if (current instanceof CannotRetryError) queue.push(current.originalError);
    if (current instanceof Error && 'cause' in current) queue.push(current.cause);
  }
  return undefined;
}
```

- [ ] **Step 4: AgentLoop 的恢复**

`src/agent/AgentEvent.ts`：
- `turn_retry` 的 reason 改为 `'reactive_compact' | 'image_limit'`；
- `recovery` 的 reason 改为 `'context_overflow' | 'reactive_compact' | 'recovery_exhausted' | 'image_limit'`。

`src/agent/AgentLoop.ts`：

1. import 区加：

```ts
import { classifyImageLimitError } from '../images/imageErrors.js';
import type {
  ImageProjectionReport,
  ImageRequestLimits,
} from '../images/prepareImagesForRequest.js';
```

2. `AgentLoopHooks.recovery` 改为：

```ts
  recovery?: {
    reactiveCompact?: (ctx: {
      messages: readonly ConversationMessage[];
    }) => AsyncGenerator<AgentEvent, boolean>;
    /** The provider said the active model does not accept images. */
    onImagesUnsupported?: () => void | Promise<void>;
  };
```

3. `RecoveryState` 改为：

```ts
type RecoveryState =
  | { phase: 'idle' }
  | {
      phase: 'retry_pending' | 'in_retried_turn';
      turn: number;
      attempt: number;
      imageLimits: ImageRequestLimits;
    };
```

4. `AgentLoopExecution` 的字段区加 `private lastImageReport?: ImageProjectionReport;`。

5. `runModel` 的 try 块改为：

```ts
    try {
      this.lastImageReport = undefined;
      const outcome = yield* runTurn({
        turnState,
        messages: this.config.conversationState.toArray(),
        streaming: this.config.streaming,
        signal: stepSignal,
        modelExecutionLifecycle: this.config.modelExecutionLifecycle,
        logger: this.config.logger,
        imageLimits: this.recovery.phase === 'in_retried_turn' ? this.recovery.imageLimits : undefined,
        onImageProjection: (report) => {
          this.lastImageReport = report;
        },
      });
      return { action: 'complete', outcome };
```

catch 块里 `if (yield* this.recoverOverflow(error)) return { action: 'retry' };` 之前加：

```ts
      if (yield* this.recoverImageLimit(error)) return { action: 'retry' };
```

6. `recoverOverflow` 中 `this.recovery = { phase: 'retry_pending', turn: this.turns, attempt: 1 };` 改为：

```ts
      this.recovery = {
        phase: 'retry_pending',
        turn: this.turns,
        attempt: 1,
        imageLimits: this.tightenedImageLimits(),
      };
```

7. 在 `recoverOverflow` 之后加：

```ts
  /** Retry limits after a refused request: no history images and half the fresh ones. */
  private tightenedImageLimits(): ImageRequestLimits {
    return {
      historyTokens: 0,
      maxFreshImages: Math.max(1, Math.floor((this.lastImageReport?.freshKept ?? 0) / 2)),
    };
  }

  private async *recoverImageLimit(error: unknown): AsyncGenerator<AgentEvent, boolean> {
    const kind = classifyImageLimitError(error);
    if (!kind || !this.lastImageReport?.kept) return false;
    if (this.recovery.phase !== 'idle') {
      yield { type: 'recovery', phase: 'failed', reason: 'recovery_exhausted' };
      return false;
    }
    if (kind === 'unsupported') await this.config.hooks?.recovery?.onImagesUnsupported?.();
    this.recovery = {
      phase: 'retry_pending',
      turn: this.turns,
      attempt: 1,
      imageLimits: this.tightenedImageLimits(),
    };
    yield { type: 'recovery', phase: 'started', reason: 'image_limit' };
    yield { type: 'recovery', phase: 'retrying', reason: 'image_limit' };
    yield { type: 'turn_retry', turn: this.turns, reason: 'image_limit' };
    return true;
  }
```

`src/agent/LoopHookBuilder.ts`：`build()` 中 hooks 的 `recovery` 改为：

```ts
      recovery: {
        reactiveCompact: deps.compactionHandler ? () => this.reactiveCompact() : undefined,
        onImagesUnsupported: () => deps.modelManager.markImagesUnsupported(),
      },
```

- [ ] **Step 5: 确认通过**

Run: `pnpm vitest run src/images src/agent`
Expected: 全部通过，原有的溢出恢复用例保持通过。

- [ ] **Step 6: 提交**

```bash
pnpm lint:fix && pnpm type-check
git add src/images/imageErrors.ts src/images/__tests__/imageErrors.test.ts src/agent/AgentLoop.ts src/agent/AgentEvent.ts src/agent/LoopHookBuilder.ts src/agent/__tests__/AgentLoop.test.ts
git commit -m "feat(images): retry a turn with fewer images when the provider refuses them"
```

---
### Task 14: 文档、changelog 与整体验证

**Files:**
- Modify: `docs/session.md`、`docs/en/session.md`
- Modify: `docs/providers.md`、`docs/en/providers.md`
- Modify: `docs/api-reference.md`、`docs/en/api-reference.md`
- Create: `.changes/image-ref-vision-budget.json`

**Interfaces:**
- Consumes：Task 1 到 13 的全部公开名字。文档里只能出现已经导出的名字：`ImageRef`、`ImageDetail`、`VisionCapability`、`VisionCapabilityOverride`、`VisionResolver`、`ImagePolicy`、`ImageStore`、`TenantImageStore`、`ImageBytes`、`ResolvedImage`、`InMemoryImageStore`、`InMemoryImageStoreOptions`、`combineImageStores`、`ImageRejectionReason`、`SessionInputErrorDetails`。

- [ ] **Step 1: Session 文档**

`docs/en/session.md`：在 `## Tools and permissions` 之前插入：

````md
## Images

Send images as `image_url` parts. `image_url` is an `ImageRef`: `url` is a
`data:` URL, an `http(s):` URL, or a reference an image store resolves;
`detail`, `mediaType`, `width`, `height`, `byteLength` and `alt` are optional.

```ts
await session.send([
  { type: 'text', text: 'Why does this page look broken?' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,...', alt: 'login page' } },
]);
```

`send()` admits every image before the input is recorded:

- Inline images must be base64 png, jpeg, gif or webp. SVG is always rejected.
  Each image must fit `images.maxImageBytes` (10 MiB by default, and never more
  than the model allows).
- One input may carry at most `images.maxImagesPerInput` images (20 by default).
- `http(s)` images go to the provider unchanged. Set `images.remoteUrls` to
  `false` to reject them. The SDK never fetches them itself.
- Any other scheme must be handled by `images.store`.

A refused image makes `send()` throw `SessionInputError` with code
`SESSION_INPUT_IMAGE_REJECTED` and `details: { index, reason }`. Through
AgentServer the same refusal is a non-retryable `INVALID_COMMAND` (HTTP 400).

### Image store

Without `images.store`, images stay inline in the transcript, as before. With
a store, inline bytes are written to it, and the transcript, the durable journal
and the events keep only the reference:

```ts
import { createSession, InMemoryImageStore } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider,
  model: 'gpt-5',
  images: { store: new InMemoryImageStore() },
});
```

`InMemoryImageStore` lasts only as long as the process. To keep images
elsewhere, or to resolve your own references such as an IM file key,
implement `ImageStore`, and join several stores with
`combineImageStores(primary, ...others)`. A Session that can be resumed needs a
store that every resuming process can read.

### Image budget

Each model request is built from a projection of the conversation. The
transcript itself is never rewritten.

- Images the model has not seen yet (those after the last assistant message)
  are kept first, up to `images.maxImagesPerRequest`.
- Older images share `images.historyTokens`, which defaults to the smaller of
  16,000 and a quarter of the input window. When they go over it, the oldest
  are replaced with `[image omitted to fit the image budget: …]`. The cut point
  moves in steps of half the allowance, so in most turns the prompt prefix,
  and with it the provider's prompt cache, stays the same.
- When the model does not accept images, every image becomes
  `[image omitted: the current model does not accept images …]`. Images in new
  input are rejected unless `images.whenUnsupported` is `'omit'`.
- If a provider still refuses a request because of its images, the turn is
  retried once, without history images and with half of the new ones.

Image token estimates come from the image size and the provider formula
(`VisionCapability.imageTokens`), never from the base64 text.
````

在同一文件 `## Context compaction` 一节末尾（`and summary requests are chunked against the model context budget.` 之后）追加一行：

```md
Images reach the summary model only as `[image: …]` descriptions, never as image data.
```

在 `## SessionOptions` 表格的 `tokenBudget` 行之后加两行：

```md
| `images` | `ImagePolicy` | Image admission limits, image store and request budget |
| `vision` | `VisionCapabilityOverride \| VisionResolver` | Override what the model accepts as image input |
```

`docs/session.md`：在 `## 工具配置` 之前插入：

````md
## 图片

图片以 `image_url` part 发送。`image_url` 的类型是 `ImageRef`，其中 `url` 可以是：

- `data:` URL；
- `http(s):` URL；
- 由图片 store 解析的引用。

`detail`、`mediaType`、`width`、`height`、`byteLength`、`alt` 都是可选字段。

```ts
await session.send([
  { type: 'text', text: '这个页面为什么显示错乱？' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,...', alt: '登录页' } },
]);
```

`send()` 在记录输入之前逐张校验图片：

- 内联图片必须是 base64 编码的 png、jpeg、gif 或 webp，SVG 一律拒绝。
- 单张不超过 `images.maxImageBytes`，默认 10 MiB，并且不会超过模型自身的上限。
- 每次输入最多 `images.maxImagesPerInput` 张，默认 20 张。
- `http(s)` 图片原样交给 provider；`images.remoteUrls` 设为 `false` 时会被拒绝。SDK 自己从不抓取这类 URL。
- 其他 scheme 必须由 `images.store` 认领。

图片不合格时，`send()` 抛出 `SessionInputError`，错误码为 `SESSION_INPUT_IMAGE_REJECTED`，`details` 为 `{ index, reason }`。通过 AgentServer 提交时，同样的拒绝表现为不可重试的 `INVALID_COMMAND`（HTTP 400）。

### 图片 store

不配置 `images.store` 时，图片和以前一样内联在 transcript 里。配置之后，内联图片的字节会写入 store，transcript、durable journal 和事件里只保留引用：

```ts
import { createSession, InMemoryImageStore } from '@blade-ai/agent-sdk';

const session = await createSession({
  provider,
  model: 'gpt-5',
  images: { store: new InMemoryImageStore() },
});
```

`InMemoryImageStore` 只在进程存活期间有效。如果要把图片放到别处，或者解析自己的引用（例如 IM 文件 key），就实现 `ImageStore` 接口，再用 `combineImageStores(primary, ...others)` 把多个 store 组合起来。可以被恢复的 Session，需要配置一个所有恢复进程都能读取的 store。

### 图片预算

每次模型请求都基于会话的一份投影视图构建，transcript 本身不会被改写：

- 模型还没看过的图片（最后一条 assistant 消息之后的）优先保留，最多 `images.maxImagesPerRequest` 张。
- 更早的图片共用 `images.historyTokens` 的预算，默认取 16,000 和输入窗口四分之一中较小的那个。超出预算时，最旧的图片会被换成 `[image omitted to fit the image budget: …]`。裁剪点每次移动半个预算，所以大多数轮次里 prompt 前缀不变，provider 的前缀缓存也能持续命中。
- 模型不收图时，所有图片都换成 `[image omitted: the current model does not accept images …]`。新输入里的图片会被拒绝，除非把 `images.whenUnsupported` 设为 `'omit'`。
- 如果 provider 仍然因为图片拒绝请求，本轮会重试一次：不带历史图片，新图片减半。

图片的 token 估算按图片尺寸和 provider 公式（`VisionCapability.imageTokens`）计算，不会对 base64 文本分词。
````

在同一文件 `### 上下文溢出恢复` 一节末尾（"不会把无界历史或文件内容塞入单次请求。"之后）追加一行：

```md
图片只会以 `[image: …]` 描述的形式出现在摘要请求里，不会把图片数据发给摘要模型。
```

在 `## SessionOptions 完整参考` 表格的 `tokenBudget` 行之后加两行，列的写法与相邻行保持一致：

```md
| `images`          | `ImagePolicy`                                           | —  | —           | 图片入口限制、图片 store 与请求预算                         |
| `vision`          | `VisionCapabilityOverride \| VisionResolver`            | —  | 按内置表     | 覆盖模型能否接收图片及相关上限                                |
```

- [ ] **Step 2: Provider 文档**

`docs/en/providers.md`：在 `## Runtime model changes` 之前插入：

````md
## Vision capability

The SDK resolves a `VisionCapability` for the active model:

| Field | Meaning |
|---|---|
| `images` | The model accepts image input |
| `toolResultImages` | Images may stay inside tool results; otherwise they are moved into a following user message (used from 7.6) |
| `mediaTypes` | Accepted media types; png, jpeg, gif and webp by default |
| `maxImageBytes` / `maxImagesPerRequest` | Provider limits |
| `imageTokens` | `'openai'`, `'anthropic'` or `'gemini'` formula, or a fixed token count per image |

Built-in defaults:

| Provider | Models | `images` | `toolResultImages` | `imageTokens` |
|---|---|---|---|---|
| `anthropic` | all but `claude-2*` and `claude-instant*` | yes | yes | `anthropic` (5 MiB, 100 per request) |
| `openai` | `gpt-3.5*`, `gpt-4`, `gpt-4-0314`, `gpt-4-0613`, `gpt-4-32k*`, `gpt-4-0125-preview`, `gpt-4-1106-preview`, `o1-mini*`, `o1-preview*`, `o3-mini*` | no | no | — |
| `openai` | every other model | yes | yes | `openai` (20 MiB) |
| `azure-openai` | same names as `openai` | as `openai` | no | `openai` |
| `gemini` | all | yes | yes | `gemini` |
| `deepseek` | `deepseek-v4-flash` and its aliases | yes | no | 1,600 |
| `deepseek` | every other model | no | no | — |
| anything else | names containing `qwq`, `deepseek-r1`, `deepseek-v4-pro`, `o1-mini`, `o3-mini` or `gpt-3.5` | no | no | — |
| anything else | every other model | yes | no | 1,600 |

Override it for a Session, either for whatever model it uses or per model:

```ts
const session = await createSession({
  provider: { type: 'openai-compatible', apiKey, baseUrl },
  model: 'qwen2.5-vl-72b-instruct',
  // vLLM serves one image per prompt unless it is started with a higher limit.
  vision: { maxImagesPerRequest: 1 },
});

const perModel = await createSession({
  provider: { type: 'openai-compatible', apiKey, baseUrl },
  model: 'internal-model',
  vision: ({ model }) => (model.startsWith('text-') ? { images: false } : undefined),
});
```

`ModelConfig.vision` overrides one registered model. Custom provider adapters
receive the resolved value as `ModelServiceConfig.vision`. When a provider
answers that a model does not accept images, the Session stops sending images
to that model.
````

`docs/providers.md`：在 `## 运行时切换模型` 之前插入：

````md
## 视觉能力

SDK 会为当前模型解析一份 `VisionCapability`：

| 字段 | 含义 |
|---|---|
| `images` | 模型是否接收图片 |
| `toolResultImages` | 图片能否留在工具结果里；不能时，会把图片移到紧随其后的 user 消息（7.6 起使用） |
| `mediaTypes` | 接受的媒体类型，默认 png、jpeg、gif、webp |
| `maxImageBytes` / `maxImagesPerRequest` | provider 的上限 |
| `imageTokens` | 估算公式：`'openai'`、`'anthropic'`、`'gemini'`，或每张图固定的 token 数 |

内置默认值：

| Provider | 模型 | `images` | `toolResultImages` | `imageTokens` |
|---|---|---|---|---|
| `anthropic` | 除 `claude-2*`、`claude-instant*` 外 | 是 | 是 | `anthropic`（单张 5 MiB，每次请求 100 张） |
| `openai` | `gpt-3.5*`、`gpt-4`、`gpt-4-0314`、`gpt-4-0613`、`gpt-4-32k*`、`gpt-4-0125-preview`、`gpt-4-1106-preview`、`o1-mini*`、`o1-preview*`、`o3-mini*` | 否 | 否 | — |
| `openai` | 其余模型 | 是 | 是 | `openai`（单张 20 MiB） |
| `azure-openai` | 与 `openai` 相同的模型名规则 | 同 `openai` | 否 | `openai` |
| `gemini` | 全部 | 是 | 是 | `gemini` |
| `deepseek` | `deepseek-v4-flash` 及其别名 | 是 | 否 | 1,600 |
| `deepseek` | 其余模型 | 否 | 否 | — |
| 其他 provider | 名称含 `qwq`、`deepseek-r1`、`deepseek-v4-pro`、`o1-mini`、`o3-mini`、`gpt-3.5` | 否 | 否 | — |
| 其他 provider | 其余模型 | 是 | 否 | 1,600 |

覆盖方式有两种：对 Session 当前使用的模型统一覆盖，或者按模型分别覆盖。

```ts
const session = await createSession({
  provider: { type: 'openai-compatible', apiKey, baseUrl },
  model: 'qwen2.5-vl-72b-instruct',
  // vLLM 默认每次请求只接收 1 张图，除非启动时调高了上限。
  vision: { maxImagesPerRequest: 1 },
});

const perModel = await createSession({
  provider: { type: 'openai-compatible', apiKey, baseUrl },
  model: 'internal-model',
  vision: ({ model }) => (model.startsWith('text-') ? { images: false } : undefined),
});
```

`ModelConfig.vision` 用来覆盖单个已注册的模型。自定义 provider adapter 可以从 `ModelServiceConfig.vision` 读到解析后的结果。如果 provider 回复某个模型不接收图片，Session 之后就不再给这个模型发图片。
````

- [ ] **Step 3: API 参考**

`docs/en/api-reference.md`：在 `## Permissions` 之前插入：

```md
## Images

Runtime:

- `InMemoryImageStore`
- `combineImageStores`

Types:

- `ImageRef`
- `ImageDetail`
- `VisionCapability`
- `VisionCapabilityOverride`
- `VisionResolver`
- `ImagePolicy`
- `ImageStore`
- `TenantImageStore`
- `ImageBytes`
- `ResolvedImage`
- `InMemoryImageStoreOptions`
- `ImageRejectionReason`
- `SessionInputErrorDetails`

See [Session · Images](./session#images) and [Providers · Vision capability](./providers#vision-capability).
```

`docs/api-reference.md`：在 `### MCP` 之前插入：

```md
### 图片

| 类型 | 说明 |
|------|------|
| `ImageRef` / `ImageDetail` | `image_url` part 的载荷：data URL、http(s) URL 或 store 引用，以及可选的元数据 |
| `VisionCapability` / `VisionCapabilityOverride` / `VisionResolver` | 模型的图片能力，以及按 Session 或按模型的覆盖方式 |
| `ImagePolicy` | 图片入口限制、store 与请求预算 |
| `ImageStore` / `TenantImageStore` / `ImageBytes` / `ResolvedImage` | 图片存储端口 |
| `InMemoryImageStore` / `InMemoryImageStoreOptions` | 进程内、按字节 LRU、按租户隔离的 store |
| `combineImageStores` | 组合多个 store：写入第一个，读取时交给认领该引用的 store |
| `ImageRejectionReason` / `SessionInputErrorDetails` | 图片被拒绝时 `SessionInputError.details` 的内容 |

用法见 [Session · 图片](./session#图片) 和 [Provider · 视觉能力](./providers#视觉能力)。
```

- [ ] **Step 4: feature changelog fragment**

创建 `.changes/image-ref-vision-budget.json`：

```json
{
  "type": "feature",
  "en": "Add image handling to Sessions. `image_url` parts carry `ImageRef` metadata (`detail`, `mediaType`, size, `alt`); `SessionOptions.vision` and a built-in table per provider say what the model accepts; `SessionOptions.images` sets admission limits, an optional `ImageStore` (`InMemoryImageStore`, `combineImageStores`) that keeps image bytes out of the transcript, and a per-request image budget. `send()` refuses images it cannot accept with `SESSION_INPUT_IMAGE_REJECTED`. Every model request keeps new images first, trims older ones in stable steps and leaves deterministic placeholders, and a turn the provider refuses for its images is retried once with fewer of them.",
  "zh-CN": "Session 新增图片处理能力。`image_url` part 可以携带 `ImageRef` 元数据（`detail`、`mediaType`、尺寸、`alt`）；`SessionOptions.vision` 与按 provider 的内置表决定模型能否收图；`SessionOptions.images` 用来设置入口限制、可选的 `ImageStore`（`InMemoryImageStore`、`combineImageStores`，图片字节因此不必留在 transcript 里）和单次请求的图片预算。`send()` 遇到不能接收的图片会抛出 `SESSION_INPUT_IMAGE_REJECTED`。每次模型请求都优先保留新图片，旧图片按稳定的步长裁剪，并用确定性的占位文本替代；如果 provider 因图片拒绝某一轮，这一轮会减少图片后重试一次。"
}
```

- [ ] **Step 5: 整体验证**

依次运行：

```bash
pnpm lint
pnpm type-check
pnpm test
pnpm changelog:check
pnpm run verify:entrypoints
```

Expected：
- 全部通过。
- `verify:entrypoints` 会重新构建，并确认浏览器构建里没有 Node 内置模块，同时 `browser.InMemoryImageStore` 可以加载。
- 如果 `pnpm test` 中出现与本期无关的失败，先在 `main` 上复现：能复现说明是已有问题，记录下来，不在本期修；只在本分支出现，就回到对应任务修复。

- [ ] **Step 6: 提交**

```bash
git add docs/session.md docs/en/session.md docs/providers.md docs/en/providers.md docs/api-reference.md docs/en/api-reference.md .changes/image-ref-vision-budget.json
git commit -m "docs(images): document image references, vision capability and the image budget"
```

---

## 规格覆盖对照（第 1 期）

| Spec 章节 | 任务 |
|---|---|
| §4.1–4.2 ImageRef 与引用形式 | Task 1、Task 3（`blade-image:`） |
| §4.3 VisionCapability、默认表、解析顺序 | Task 1、Task 4 |
| §4.4 ImagePolicy 与默认值 | Task 1、Task 8 |
| §4.5 ImageStore 端口与 `combineImageStores` | Task 1、Task 3 |
| §4.6 导出 | Task 1、Task 3、Task 8、Task 14 |
| §4.7 7.x 兼容（schema 放宽、`features` 宽松解析） | Task 7 |
| §5 入口规范化、错误码 | Task 8、Task 9 |
| §6 请求投影、稳定裁剪、解析与缓存、占位文本、可观测性 | Task 10、Task 11、Task 12 |
| §6.2 第 9 步 detail 映射 | Task 12 |
| §7.1–7.3 估算、TokenCounter、压缩 | Task 5、Task 6 |
| §7.4 图片错误恢复、收紧模式、运行期降级 | Task 13 |
| §11 文档（第 1 期涉及的部分） | Task 14 |

不在本期（spec §12 的第 2、3 期）：`ToolResult.images`、`imageFromBytes`、工具图片改放与 microcompact 对数组 content 的处理、Read 和 MCP 返回图片、`FileImageStore`、`PostgresImageStore`、`prune`、AgentServer 的上传和读取路由、AgentClient、preset 与示例。
