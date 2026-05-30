# DeepSeek 模型 API 调研

> 调研日期：2026-05-26；价格与 Batch API 状态在 2026-05-30 再次核对。DeepSeek API 模型、价格和能力边界变化较快，接入前应再次核对官方文档。

## 结论摘要

DeepSeek API 当前主线是 OpenAI/Anthropic 兼容格式，OpenAI 格式 `base_url` 为 `https://api.deepseek.com`，Anthropic 格式为 `https://api.deepseek.com/anthropic`。当前官方模型列表以 `deepseek-v4-flash`、`deepseek-v4-pro` 为主，`deepseek-chat` 和 `deepseek-reasoner` 仍可作为兼容别名使用；二者分别对应 `deepseek-v4-flash` 的非思考模式和思考模式。新接入不要把旧别名作为唯一模型 ID，应允许用户直接传入官方新模型名。

对 SDK 适配而言，可以先把 DeepSeek 视为“Chat Completions 兼容 + provider 扩展参数”的模型源，而不是完整 OpenAI 平台等价实现。关键差异集中在：

- DeepSeek 的 `thinking`、`reasoning_content`、缓存命中统计是 provider 特有字段。
- JSON Output、Chat Prefix Completion、FIM Completion、Strict Tool Calls 有额外触发条件或 beta base URL。
- FIM 走 `/completions`，不是 `/chat/completions`，且官方 API reference 当前只列 `deepseek-v4-pro`。
- Thinking mode 下采样参数可能被静默忽略，工具调用时历史 `reasoning_content` 的回传规则会影响 400 错误。
- 本文基于官方文档调研；没有在仓库内使用任务描述中的 API key 发起真实 DeepSeek 请求，避免把密钥写入日志或测试产物。

## 官方入口

| 项目 | 说明 |
| --- | --- |
| OpenAI 兼容 base URL | `https://api.deepseek.com` |
| Anthropic 兼容 base URL | `https://api.deepseek.com/anthropic` |
| Beta base URL | `https://api.deepseek.com/beta`，用于 Chat Prefix、FIM、Strict Tool Calls 等 beta 能力 |
| Chat endpoint | `POST /chat/completions` |
| FIM endpoint | `POST /completions` |
| Models endpoint | `GET /models` |

参考：

- https://api-docs.deepseek.com/
- https://api-docs.deepseek.com/quick_start/pricing
- https://api-docs.deepseek.com/api/create-chat-completion
- https://api-docs.deepseek.com/api/create-completion
- https://api-docs.deepseek.com/api/list-models

## 模型与能力矩阵

| 模型 ID | 当前定位 | Thinking mode | JSON Output | Tool Calls | Chat Prefix | FIM | 上下文/输出 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `deepseek-v4-flash` | 当前低成本/高并发主力模型 | 支持，默认 enabled | 支持 | 支持 | 支持 | 仅非思考模式 | 1M context，最大 384K output |
| `deepseek-v4-pro` | 当前高能力模型 | 支持，默认 enabled | 支持 | 支持 | 支持 | 仅非思考模式，FIM API 当前只列该模型 | 1M context，最大 384K output |
| `deepseek-chat` | 兼容别名 | 对应 `deepseek-v4-flash` 非思考模式 | 按别名对应能力 | 按别名对应能力 | 按别名对应能力 | 不建议新接入依赖 | 保留兼容，但新代码优先用 V4 模型名 |
| `deepseek-reasoner` | 兼容别名 | 对应 `deepseek-v4-flash` 思考模式 | 按别名对应能力 | 按别名对应能力 | 按别名对应能力 | 不适合作为 FIM 默认模型 | 保留兼容，但新代码优先用 V4 模型名 |

历史线索：

- DeepSeek-V3 在 2024-12-26 发布，DeepSeek-V3-0324 在 2025-03-25 发布；0324 官方强调推理、前端开发和 tool-use 能力增强，API 用法保持不变。
- DeepSeek-R1 在 2025-01-20 发布，API 侧通过 `model=deepseek-reasoner` 使用。
- DeepSeek-R1-0528 在 2025-05-28 发布，官方说明支持 JSON output 和 function calling。
- DeepSeek-V3.1 在 2025-08-21 发布，官方 API 更新把 `deepseek-chat` 定义为非思考模式、`deepseek-reasoner` 定义为思考模式，当时上下文为 128K。
- DeepSeek-V4 Preview 在 2026-04-24 后成为当前文档主线，模型上下文提升到 1M，最大输出提升到 384K。

参考：

- https://api-docs.deepseek.com/news/news1226
- https://api-docs.deepseek.com/news/news250120
- https://api-docs.deepseek.com/news/news250325
- https://api-docs.deepseek.com/news/news250528
- https://api-docs.deepseek.com/news/news250821
- https://api-docs.deepseek.com/news/news260424

## OpenAI 兼容范围

DeepSeek 的 OpenAI 兼容主要覆盖 Chat Completions 形态：

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
});

const response = await client.chat.completions.create({
  model: 'deepseek-v4-pro',
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello' },
  ],
  stream: false,
  reasoning_effort: 'high',
  // OpenAI SDK 中 Python 示例需要通过 extra_body 传；JS SDK 可直接传入额外字段。
  thinking: { type: 'enabled' },
});
```

适配注意：

- 不要假设 DeepSeek 支持 OpenAI Responses API、Assistants API、Threads、Files、Batches、Embeddings 等平台级接口；当前调研只确认 Chat/FIM/Models/Balance 等 API。2026-05-30 核对公开文档时，`/api/list-batches` 与 `/api/create-batch` 文档页返回 404，因此 SDK 的批量能力应实现为 `/chat/completions` 上的客户端 bounded concurrency helper，而不是伪装成官方 Batch endpoint。
- `baseURL` 不需要补 `/v1`，官方示例直接使用 `https://api.deepseek.com`。
- beta 能力必须切换到 `https://api.deepseek.com/beta`，不能只改请求 body。
- `finish_reason` 除 OpenAI 常见值外，还可能出现 `insufficient_system_resource`。
- SSE 流式协议以 `data: [DONE]` 结束，和 OpenAI Chat Completions 兼容。
- `usage` 中有 `prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`；thinking/FIM 响应还可能有 `completion_tokens_details.reasoning_tokens`。

## 价格与成本口径

DeepSeek 官方价格页按模型、输入缓存命中/未命中、输出 token 分别计价。SDK 不应该把成本计算硬编码成单一每 token 价格：

- 输入 token 要区分 `prompt_cache_hit_tokens` 与 `prompt_cache_miss_tokens`。
- 输出 token 要区分普通输出与 reasoning token。官方响应中 reasoning token 位于 `completion_tokens_details.reasoning_tokens`。
- 批量、缓存和模型版本的价格可能独立变化，成本工具应从可配置 price table 读取。
- 文档、测试和示例中不要包含真实 API key；集成测试通过环境变量注入密钥，并默认跳过。

参考：https://api-docs.deepseek.com/quick_start/pricing

## Thinking Mode / R1 类能力

Thinking mode 是当前 DeepSeek 推理模型能力的核心抽象。开启后，模型会先输出推理内容，再输出最终回答：

- 控制参数：`thinking: { type: 'enabled' | 'disabled' }`。
- 思考强度：OpenAI 格式用 `reasoning_effort: 'high' | 'max'`；兼容层会把 `low`、`medium` 映射到 `high`，把 `xhigh` 映射到 `max`。
- 默认：官方文档标注 thinking toggle 默认 enabled。
- 非兼容点：thinking mode 不支持 `temperature`、`top_p`、`presence_penalty`、`frequency_penalty`；为兼容现有软件，传这些参数不会报错，但不会生效。
- 返回字段：推理内容通过 `message.reasoning_content` 或流式 `delta.reasoning_content` 返回，最终答案仍在 `content`。
- 多轮对话：普通多轮里，旧轮次 `reasoning_content` 可以不参与上下文；如果中间发生 tool call，相关 `assistant.reasoning_content` 必须在后续请求中继续回传，否则 API 会返回 400。

SDK 适配建议：

- 将 `reasoning_content` 映射到内部 reasoning event，不要拼进最终 assistant text。
- 历史消息存储需要保留 `reasoning_content`，尤其是 tool call 分支；UI 渲染可以选择隐藏，但 raw continuation context 不能丢。
- 如果 SDK 暴露 `temperature` 等采样参数，应在 thinking mode 下给 warning，避免用户误以为生效。
- 如果使用 Vercel AI SDK 的 `@ai-sdk/deepseek`，其 provider 已支持 `thinking` providerOptions、stream reasoning、cache token metadata、tool streaming；但模型 ID 列表示例仍偏向 `deepseek-chat`/`deepseek-reasoner`，新接入应允许传任意 DeepSeek model ID 字符串。

参考：

- https://api-docs.deepseek.com/guides/thinking_mode
- https://ai-sdk.dev/providers/ai-sdk-providers/deepseek

## JSON Output

DeepSeek 的 JSON Output 不是 OpenAI Structured Outputs 等价物。它的触发方式是：

- 请求中设置 `response_format: { type: 'json_object' }`。
- system 或 user prompt 必须包含 `json` 这个词。
- prompt 中建议提供期望 JSON 结构示例。
- `max_tokens` 要留足，避免 JSON 中途截断。
- 官方提示该能力偶尔可能返回空内容，可通过调整 prompt 缓解。

适配建议：

- SDK 的 `object generation` 如果只映射到 `json_object`，需要在 system prompt 自动补充 JSON 指令。
- 不要把它标记为严格 schema 约束能力；schema 约束更接近 tool strict mode，但也有 DeepSeek 自己的 JSON Schema 限制。
- 对空 content + `response_format=json_object` 的返回做可重试或可诊断错误。

参考：https://api-docs.deepseek.com/guides/json_mode

## Tool Calls / Function Calling

DeepSeek 支持 OpenAI 风格 `tools` 和 `tool_calls`。模型只返回函数调用参数，外部函数执行仍由调用方负责。当前文档区分非思考模式和思考模式：

- 非思考模式：普通 function calling 流程和 OpenAI Chat Completions 接近。
- 思考模式：DeepSeek-V3.2 起支持 tool use in thinking mode；如果某一轮产生 tool call，后续请求必须继续带上该轮 `reasoning_content`。
- Strict mode beta：要求 `base_url="https://api.deepseek.com/beta"`，并且所有 function 都设置 `strict: true`。

Strict mode JSON Schema 限制：

- 支持类型：`object`、`string`、`number`、`integer`、`boolean`、`array`、`enum`、`anyOf`。
- 每个 `object` 的所有属性都必须在 `required` 中声明。
- 每个 `object` 必须设置 `additionalProperties: false`。
- `string` 支持 `pattern` 和部分 `format`：`email`、`hostname`、`ipv4`、`ipv6`、`uuid`；不支持 `minLength`、`maxLength`。
- `array` 不支持 `minItems`、`maxItems`。
- 数字类型支持 `const`、`default`、`minimum`、`maximum`、`exclusiveMinimum`、`exclusiveMaximum`、`multipleOf`。

适配建议：

- 从 Zod/JSON Schema 转换工具生成 DeepSeek strict schema 时，需要做 DeepSeek 方言清洗：补齐 required、强制 `additionalProperties: false`、移除不支持的长度和数组数量约束。
- 如果内部工具 schema 依赖 optional property，DeepSeek strict mode 下不能原样使用；可把 optional 显式建模为 nullable/anyOf，或降级到非 strict。
- tool call 历史消息需要保留 `tool_call_id`、`tool_calls`、`reasoning_content` 三类字段。

参考：https://api-docs.deepseek.com/guides/tool_calls

## Chat Prefix Completion

Chat Prefix Completion 是 Chat Completion API 的 beta 扩展，适合“给定 assistant 开头，让模型继续写”的场景，例如强制从代码块开始输出。

触发条件：

- 使用 `base_url="https://api.deepseek.com/beta"`。
- `messages` 最后一条必须是 `role: 'assistant'`。
- 最后一条 assistant message 需要设置 `prefix: true`。
- assistant `content` 是模型需要续写的前缀。

示例形态：

```json
[
  { "role": "user", "content": "Please write quick sort code" },
  { "role": "assistant", "content": "```python\n", "prefix": true }
]
```

适配建议：

- 这不是普通 system prompt 能稳定替代的能力，应作为 provider-specific option 暴露。
- 如果 SDK 的 message 类型没有 `prefix` 扩展字段，需要保留 escape hatch，例如 `providerOptions.deepseek.prefixLastAssistantMessage` 或允许 raw message extra fields。

参考：https://api-docs.deepseek.com/guides/chat_prefix_completion

## FIM Completion

FIM（Fill In the Middle）用于 prefix/suffix 中间补全，常用于代码补全。

关键边界：

- 使用 beta base URL：`https://api.deepseek.com/beta`。
- endpoint 是 `POST /completions`，不是 chat endpoint。
- 请求字段包含 `prompt`、可选 `suffix`、`max_tokens`、`stop`、`stream`、`logprobs` 等。
- 官方 guide 标注 FIM max tokens 为 4K。
- 官方模型能力表标注 FIM 只支持非思考模式。
- API reference 当前 `model` possible values 只列 `deepseek-v4-pro`。
- `frequency_penalty`、`presence_penalty` 在 FIM API 中已标注 deprecated，传入不会生效。

适配建议：

- 不要把 FIM 复用到 `chat.completions.create`；应新增 completion/fim 分支或 provider-specific method。
- IDE/code completion 场景优先使用 `deepseek-v4-pro` + non-thinking mode。
- 如果统一抽象里存在 `suffix`，需要仅在 DeepSeek beta/FIM 路径启用，避免误传到 chat。

参考：

- https://api-docs.deepseek.com/guides/fim_completion
- https://api-docs.deepseek.com/api/create-completion

## Context Caching

DeepSeek Context Caching 默认对所有用户启用，调用方无需改代码。缓存命中基于请求前缀复用：

- 首次请求会构建硬盘缓存。
- 后续请求如果完整匹配已持久化的缓存前缀单元，就会命中缓存。
- 长输入/长输出会按固定 token 间隔持久化前缀单元，降低长前缀完全无法命中的概率。
- 响应 `usage` 增加 `prompt_cache_hit_tokens` 与 `prompt_cache_miss_tokens`。
- 缓存是 best-effort，不保证 100% 命中；构建需要数秒，闲置后通常数小时到数天内清理。

适配建议：

- 在 SDK usage metadata 中保留 DeepSeek 的 cache hit/miss token，便于成本观测。
- 对 agent 多轮、长文件上下文、RAG 场景，应尽量保持稳定的 system/developer prefix 和文档排序，以提高命中率。

参考：https://api-docs.deepseek.com/guides/kv_cache

## 与 OpenAI 适配的差异清单

| 维度 | OpenAI 常见语义 | DeepSeek 当前语义 | 适配影响 |
| --- | --- | --- | --- |
| Base URL | 常见为 `https://api.openai.com/v1` | `https://api.deepseek.com`，beta 为 `/beta` | provider 配置不能机械追加 `/v1` |
| 模型 ID | 模型 ID 通常稳定但按平台更新 | `deepseek-chat`/`deepseek-reasoner` 是兼容别名，新能力主线在 V4 模型名 | 新代码优先用 `deepseek-v4-flash`/`deepseek-v4-pro`，但保留任意字符串透传 |
| 推理内容 | OpenAI reasoning 模型返回形态与 Responses API 强绑定 | Chat Completions 中返回 `reasoning_content` | 内部消息模型要支持 provider reasoning part |
| Thinking 控制 | 不同模型/接口控制不同 | `thinking` + `reasoning_effort` | 需要透传 providerOptions |
| Sampling 参数 | 通常可生效或报错 | thinking mode 下部分参数静默无效 | 需要 warning/文档说明 |
| JSON Mode | `response_format` 能约束 JSON object | 还要求 prompt 含 `json`，偶发空 content | 需要 prompt 注入与空响应处理 |
| Strict schema | OpenAI Structured Outputs 支持较完整 schema 子集 | DeepSeek strict tools 有自己的 schema 限制 | schema 转换需要 DeepSeek 方言化 |
| Prefix completion | OpenAI Chat Completions 无标准 `prefix` message 字段 | beta chat 需要最后一条 assistant 设置 `prefix: true` | 需要 raw extra field 或专用 API |
| FIM | OpenAI 当前没有等价通用接口 | beta `/completions` + `prompt`/`suffix` | 需要独立能力分支 |
| Context cache | OpenAI prompt caching 按模型/接口规则 | 默认硬盘缓存，usage 返回 hit/miss token | usage metadata 要保留 provider 字段 |
| 图片输入 | OpenAI 多模态模型支持图片 | Vercel AI SDK 当前 DeepSeek provider 能力表标注不支持 image input | 不要把 DeepSeek 标成视觉模型 |

## Blade Agent SDK 后续适配建议

1. Provider 配置层：DeepSeek 默认 base URL 使用 `https://api.deepseek.com`，同时允许用户覆盖 `baseUrl`；beta 能力不要默认启用，应由 capability 或 provider option 显式切换。
2. 模型注册层：新增 `deepseek-v4-flash`、`deepseek-v4-pro`；保留 `deepseek-chat`、`deepseek-reasoner` 作为兼容 alias，同时允许任意 DeepSeek 模型 ID 字符串透传。
3. 消息模型：支持 `reasoning_content` 的 raw 保存、stream event 映射和历史回放，尤其保证 tool call 后不丢失。
4. 工具 schema：为 DeepSeek strict mode 增加 schema sanitizer；无法无损转换时降级到非 strict 并给 warning。
5. 结构化输出：JSON mode 自动补充 JSON 指令，空 content 进入可重试错误类型。
6. FIM 能力：不要塞进通用 chat loop；面向代码补全单独暴露，默认 non-thinking + beta `/completions`。
7. Usage 统计：把 `prompt_cache_hit_tokens`、`prompt_cache_miss_tokens`、`reasoning_tokens` 放入 provider metadata。
8. 文档：在 provider 文档中明确 DeepSeek 是 OpenAI-compatible chat provider，不是 OpenAI 全平台替代。

## 建议实现优先级

1. 先实现稳定 chat path：`/chat/completions`、stream、非 stream、基础 error mapping、providerOptions 透传。
2. 第二步补 reasoning path：`thinking`、`reasoning_effort`、`reasoning_content` 流式事件和历史回放。
3. 第三步补工具调用：普通 tool calls、strict schema sanitizer、tool call 后的 reasoning context 保留。
4. 第四步补 provider 扩展能力：JSON Output prompt guard、Chat Prefix、FIM `/completions`。
5. 最后补成本与缓存观测：cache hit/miss token、reasoning token、可配置价格表。
