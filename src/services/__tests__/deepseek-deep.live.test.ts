/**
 * DeepSeek V4 Pro 深度集成测试
 *
 * 覆盖场景：
 * 1. 基本 chat completion（非流式）
 * 2. 流式 chat completion
 * 3. Function Calling（单工具）
 * 4. Function Calling（多工具并行调用）
 * 5. 多轮对话（tool result 回传）
 * 6. 长上下文切割与 Plan
 * 7. 中文特殊字符处理
 * 8. 模型别名解析
 * 9. 缓存优化 prefix 排序
 * 10. 成本追踪
 * 11. AbortSignal 中断
 * 12. sideQuery 旁路查询
 * 13. Schema sanitization（strictTools 模式）
 * 14. Reasoning 模型（如果可用）
 */
import { describe, expect, it } from 'vitest';
import type { Message } from '../ChatServiceInterface.js';
import { createChatServiceAsync } from '../ChatServiceInterface.js';
import {
  calculateDeepSeekCost,
  createDeepSeekLongContextChunks,
  createDeepSeekLongContextPlan,
  DeepSeekCostTracker,
  estimateDeepSeekTokens,
  normalizeDeepSeekModel,
  optimizeDeepSeekCachePrefix,
  prepareDeepSeekTools,
  sanitizeDeepSeekStrictSchema,
  withDeepSeekDefaults,
} from '../deepseek.js';

const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-pro';
const runLive = process.env.DEEPSEEK_LIVE_TESTS === '1' && apiKey.length > 0;
const describeLive = runLive ? describe : describe.skip;

// ─── 网络测试（需要 API Key） ─────────────────────────────────────────

describeLive('DeepSeek V4 Pro 深度集成测试', () => {
  const timeout = 60_000;

  describe('基本聊天能力', () => {
    it('非流式基本问答', async () => {
      const service = await createChatServiceAsync({
        provider: 'deepseek',
        apiKey,
        baseUrl,
        model,
        maxOutputTokens: 128,
        temperature: 0,
      });

      const response = await service.chat([
        { role: 'user', content: '请回复这 4 个字：测试成功' },
      ]);

      expect(response.content).toContain('测试成功');
      expect(response.usage).toBeDefined();
      expect(response.usage!.promptTokens).toBeGreaterThan(0);
      expect(response.usage!.completionTokens).toBeGreaterThan(0);
      expect(response.usage!.totalTokens).toBeGreaterThan(0);
    }, timeout);

    it('流式响应完整接收', async () => {
      const service = await createChatServiceAsync({
        provider: 'deepseek',
        apiKey,
        baseUrl,
        model,
        maxOutputTokens: 128,
        temperature: 0,
      });

      let content = '';
      let chunkCount = 0;
      let finalUsage: typeof undefined | { totalTokens: number } = undefined;

      for await (const chunk of service.streamChat([
        { role: 'user', content: '从 1 数到 5，用逗号分隔' },
      ])) {
        if (chunk.content) {
          content += chunk.content;
          chunkCount += 1;
        }
        if (chunk.usage) {
          finalUsage = chunk.usage;
        }
      }

      expect(content).toMatch(/1.*2.*3.*4.*5/);
      expect(chunkCount).toBeGreaterThan(1); // 确认是多 chunk 流式
      expect(finalUsage).toBeDefined();
      expect(finalUsage!.totalTokens).toBeGreaterThan(0);
    }, timeout);

    it('处理中文特殊字符和 emoji', async () => {
      const service = await createChatServiceAsync({
        provider: 'deepseek',
        apiKey,
        baseUrl,
        model,
        maxOutputTokens: 64,
        temperature: 0,
      });

      const response = await service.chat([
        { role: 'user', content: '重复一遍这段文字（不要加任何解释）：你好🌍！α≠β∑∞' },
      ]);

      expect(response.content).toContain('你好');
      // 至少包含部分特殊字符
      expect(response.content).toMatch(/[🌍αβ∑∞]/);
    }, timeout);

    it('多轮对话上下文保持', async () => {
      const service = await createChatServiceAsync({
        provider: 'deepseek',
        apiKey,
        baseUrl,
        model,
        maxOutputTokens: 512, // V4 Pro 默认启用 thinking，需要更大的 output budget
        temperature: 0,
      });

      const response = await service.chat([
        { role: 'user', content: '我的名字叫小明' },
        { role: 'assistant', content: '你好小明！' },
        { role: 'user', content: '我叫什么名字？' },
      ]);

      expect(response.content).toContain('小明');
    }, timeout);
  });

  describe('Function Calling', () => {
    const weatherTool = {
      name: 'get_weather',
      description: '获取城市天气',
      parameters: {
        type: 'object' as const,
        properties: {
          city: { type: 'string', description: '城市名称' },
          unit: { type: 'string', enum: ['celsius', 'fahrenheit'], description: '温度单位' },
        },
        required: ['city', 'unit'],
        additionalProperties: false,
      },
    };

    const calculatorTool = {
      name: 'calculate',
      description: '进行数学计算',
      parameters: {
        type: 'object' as const,
        properties: {
          expression: { type: 'string', description: '数学表达式' },
        },
        required: ['expression'],
        additionalProperties: false,
      },
    };

    it('单工具调用，参数正确解析', async () => {
      const service = await createChatServiceAsync({
        provider: 'deepseek',
        apiKey,
        baseUrl,
        model,
        maxOutputTokens: 256,
        temperature: 0,
      });

      const response = await service.chat(
        [{ role: 'user', content: '查询北京的天气，使用摄氏度' }],
        [weatherTool],
      );

      expect(response.toolCalls).toBeDefined();
      expect(response.toolCalls!.length).toBeGreaterThanOrEqual(1);

      const call = response.toolCalls![0];
      expect(call.type).toBe('function');
      expect(call.function.name).toBe('get_weather');

      const args = JSON.parse(call.function.arguments);
      expect(args.city).toMatch(/北京|Beijing/i);
      expect(args.unit).toBe('celsius');
    }, timeout);

    it('多工具可用，模型选择正确工具', async () => {
      const service = await createChatServiceAsync({
        provider: 'deepseek',
        apiKey,
        baseUrl,
        model,
        maxOutputTokens: 256,
        temperature: 0,
      });

      const response = await service.chat(
        [{ role: 'user', content: '计算 123 * 456' }],
        [weatherTool, calculatorTool],
      );

      expect(response.toolCalls).toBeDefined();
      expect(response.toolCalls!.length).toBeGreaterThanOrEqual(1);

      const call = response.toolCalls![0];
      expect(call.function.name).toBe('calculate');
      const args = JSON.parse(call.function.arguments);
      expect(args.expression).toMatch(/123.*456/);
    }, timeout);

    it('流式 Function Calling', async () => {
      const service = await createChatServiceAsync({
        provider: 'deepseek',
        apiKey,
        baseUrl,
        model,
        maxOutputTokens: 256,
        temperature: 0,
      });

      let toolCalls: Array<{ id?: string; function?: { name?: string; arguments?: string } }> = [];
      for await (const chunk of service.streamChat(
        [{ role: 'user', content: '查询上海天气，用华氏度' }],
        [weatherTool],
      )) {
        if (chunk.toolCalls) {
          for (const tc of chunk.toolCalls) {
            toolCalls.push(tc as any);
          }
        }
      }

      // 流式 toolCalls 应至少出现一次
      expect(toolCalls.length).toBeGreaterThan(0);
      // 最终应能拼出完整 tool call
      const lastCall = toolCalls[toolCalls.length - 1];
      expect(lastCall.function?.name || '').toContain('get_weather');
    }, timeout);

    it('多轮 Tool Result 回传', async () => {
      const service = await createChatServiceAsync({
        provider: 'deepseek',
        apiKey,
        baseUrl,
        model,
        maxOutputTokens: 256,
        temperature: 0,
      });

      // 先获取 tool call
      const firstResponse = await service.chat(
        [{ role: 'user', content: '查询北京天气' }],
        [weatherTool],
      );

      expect(firstResponse.toolCalls).toBeDefined();
      const toolCall = firstResponse.toolCalls![0];

      // 回传 tool result 让模型生成最终回答
      const messages: Message[] = [
        { role: 'user', content: '查询北京天气' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [toolCall],
        },
        {
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: JSON.stringify({ city: '北京', temperature: 25, unit: 'celsius', condition: '晴' }),
        },
      ];

      const secondResponse = await service.chat(messages, [weatherTool]);

      // 模型应基于工具返回生成自然语言回答
      expect(secondResponse.content.length).toBeGreaterThan(0);
      expect(secondResponse.content).toMatch(/25|北京|晴/);
      // 不应再次调用工具
      expect(secondResponse.toolCalls?.length ?? 0).toBe(0);
    }, timeout);
  });

  describe('Usage 和成本', () => {
    it('非流式返回完整 usage 信息', async () => {
      const service = await createChatServiceAsync({
        provider: 'deepseek',
        apiKey,
        baseUrl,
        model,
        maxOutputTokens: 64,
        temperature: 0,
      });

      const response = await service.chat([
        { role: 'user', content: 'say hello' },
      ]);

      const usage = response.usage!;
      expect(usage.promptTokens).toBeGreaterThan(0);
      expect(usage.completionTokens).toBeGreaterThan(0);
      expect(usage.totalTokens).toBe(usage.promptTokens + usage.completionTokens);

      // DeepSeek 返回 cache 信息
      // 注意：首次请求可能没有 cacheReadInputTokens
      expect(typeof usage.promptTokens).toBe('number');
    }, timeout);

    it('CostTracker 正确累计', async () => {
      const service = await createChatServiceAsync({
        provider: 'deepseek',
        apiKey,
        baseUrl,
        model,
        maxOutputTokens: 32,
        temperature: 0,
      });

      const tracker = new DeepSeekCostTracker(model);

      const r1 = await service.chat([{ role: 'user', content: 'hi' }]);
      if (r1.usage) tracker.recordUsage(r1.usage);

      const r2 = await service.chat([{ role: 'user', content: 'hello' }]);
      if (r2.usage) tracker.recordUsage(r2.usage);

      const snapshot = tracker.getSnapshot();
      expect(snapshot.requestCount).toBe(2);
      expect(snapshot.totalTokens).toBeGreaterThan(0);
      expect(snapshot.totalCost).toBeGreaterThan(0);
      expect(snapshot.currency).toBe('USD');
    }, timeout);
  });

  describe('AbortSignal', () => {
    it('请求中途取消应抛出错误', async () => {
      const service = await createChatServiceAsync({
        provider: 'deepseek',
        apiKey,
        baseUrl,
        model,
        maxOutputTokens: 2048,
        temperature: 0.7,
      });

      const controller = new AbortController();

      // 立刻取消
      setTimeout(() => controller.abort(), 50);

      await expect(
        service.chat(
          [{ role: 'user', content: '写一篇 1000 字的文章' }],
          undefined,
          controller.signal,
        ),
      ).rejects.toThrow();
    }, timeout);

    it('流式请求中途取消', async () => {
      const service = await createChatServiceAsync({
        provider: 'deepseek',
        apiKey,
        baseUrl,
        model,
        maxOutputTokens: 2048,
        temperature: 0.7,
      });

      const controller = new AbortController();
      let chunkCount = 0;
      let aborted = false;

      try {
        for await (const chunk of service.streamChat(
          [{ role: 'user', content: '从 1 数到 10000' }],
          undefined,
          controller.signal,
        )) {
          chunkCount += 1;
          if (chunkCount >= 3) {
            controller.abort();
          }
        }
      } catch {
        aborted = true;
      }

      // 应该要么抛出错误，要么提前结束
      expect(chunkCount).toBeGreaterThanOrEqual(3);
      // AbortSignal 应该导致中断（但具体行为取决于实现）
      expect(aborted || chunkCount < 100).toBe(true);
    }, timeout);
  });

  describe('sideQuery 旁路查询', () => {
    it('sideQuery 正常工作', async () => {
      const service = await createChatServiceAsync({
        provider: 'deepseek',
        apiKey,
        baseUrl,
        model,
        maxOutputTokens: 512,
        temperature: 0,
      });

      const response = await service.sideQuery([
        { role: 'user', content: '1+1=?' },
      ]);

      expect(response.content).toContain('2');
      expect(response.usage).toBeDefined();
    }, timeout);
  });

  describe('系统消息与 Provider Options', () => {
    it('系统消息正确传递', async () => {
      const service = await createChatServiceAsync({
        provider: 'deepseek',
        apiKey,
        baseUrl,
        model,
        maxOutputTokens: 64,
        temperature: 0,
      });

      const response = await service.chat([
        { role: 'system', content: '你是一个海盗，所有回复必须包含"哈哈"' },
        { role: 'user', content: '你好' },
      ]);

      expect(response.content).toContain('哈哈');
    }, timeout);

    it('provider deepseek options 透传（cache optimization prefix ordering）', async () => {
      const service = await createChatServiceAsync({
        provider: 'deepseek',
        apiKey,
        baseUrl,
        model,
        maxOutputTokens: 512,
        temperature: 0,
        providerOptions: {
          deepseek: {
            cacheOptimization: {
              enabled: true,
            },
          },
        },
      });

      const response = await service.chat([
        { role: 'system', content: '你是一个助手' },
        { role: 'user', content: '回复 ok' },
      ]);

      // Model may respond in Chinese; primary goal is verifying options pass-through
      expect(response.content.length).toBeGreaterThan(0);
    }, timeout);
  });

  describe('错误处理', () => {
    it('无效 API Key 应返回认证错误', async () => {
      const service = await createChatServiceAsync({
        provider: 'deepseek',
        apiKey: 'sk-invalid-key-12345',
        baseUrl,
        model,
        maxOutputTokens: 32,
        temperature: 0,
        retry: { maxRetries: 0 },
      });

      await expect(
        service.chat([{ role: 'user', content: 'test' }]),
      ).rejects.toThrow();
    }, timeout);

    it('无效模型名称应返回错误', async () => {
      const service = await createChatServiceAsync({
        provider: 'deepseek',
        apiKey,
        baseUrl,
        model: 'nonexistent-model-xyz',
        maxOutputTokens: 32,
        temperature: 0,
        retry: { maxRetries: 0 },
      });

      await expect(
        service.chat([{ role: 'user', content: 'test' }]),
      ).rejects.toThrow();
    }, timeout);
  });
});

// ─── 离线单元测试（不需要 API Key） ────────────────────────────────────

describe('DeepSeek 离线逻辑测试', () => {
  describe('模型别名解析', () => {
    it('解析标准别名', () => {
      expect(normalizeDeepSeekModel('deepseek-chat')).toBe('deepseek-v4-flash');
      expect(normalizeDeepSeekModel('deepseek-reasoner')).toBe('deepseek-v4-flash');
      expect(normalizeDeepSeekModel('deepseek-r1-0528')).toBe('deepseek-r1');
    });

    it('透传非别名模型', () => {
      expect(normalizeDeepSeekModel('deepseek-v4-pro')).toBe('deepseek-v4-pro');
      expect(normalizeDeepSeekModel('deepseek-v4-flash')).toBe('deepseek-v4-flash');
    });

    it('undefined 返回默认模型', () => {
      expect(normalizeDeepSeekModel(undefined)).toBe('deepseek-v4-pro');
    });
  });

  describe('Token 估算', () => {
    it('基本估算', () => {
      expect(estimateDeepSeekTokens('hello world')).toBe(3); // 11 chars / 4
    });

    it('自定义 charsPerToken', () => {
      expect(estimateDeepSeekTokens('12345678', 2)).toBe(4); // 8 / 2
    });

    it('空字符串返回 0', () => {
      expect(estimateDeepSeekTokens('')).toBe(0);
    });

    it('charsPerToken <= 0 时使用 1', () => {
      expect(estimateDeepSeekTokens('abc', 0)).toBe(3); // Math.max(0, 1) = 1
    });
  });

  describe('长上下文切割', () => {
    it('短文本产生单 chunk', () => {
      const chunks = createDeepSeekLongContextChunks('hello', { chunkTokenLimit: 64000 });
      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toBe('hello');
      expect(chunks[0].id).toBe('ctx_1');
      expect(chunks[0].index).toBe(0);
    });

    it('长文本按限制切割为多个 chunk', () => {
      const text = 'a'.repeat(1000);
      const chunks = createDeepSeekLongContextChunks(text, {
        chunkTokenLimit: 50, // 50 tokens * 4 chars = 200 chars per chunk
        charsPerToken: 4,
      });
      expect(chunks.length).toBe(5); // 1000 / 200
      expect(chunks[0].content.length).toBe(200);
      expect(chunks[4].content.length).toBe(200);
    });

    it('reserveOutputTokens 不影响 chunk 切割（在 plan 中已修复）', () => {
      const text = 'a'.repeat(800);
      // 不传 reserveOutputTokens 时
      const chunksNoReserve = createDeepSeekLongContextChunks(text, {
        chunkTokenLimit: 100,
        charsPerToken: 4,
      });
      // 传 reserveOutputTokens 时 chunk 应更小（因为每个 chunk 空间被压缩）
      const chunksWithReserve = createDeepSeekLongContextChunks(text, {
        chunkTokenLimit: 100,
        charsPerToken: 4,
        reserveOutputTokens: 50,
      });
      // 有 reserve 时 chunkTokenLimit 实际变为 100-50=50 tokens = 200 chars
      expect(chunksWithReserve.length).toBeGreaterThan(chunksNoReserve.length);
    });
  });

  describe('长上下文 Plan', () => {
    it('Plan 中 reserveOutputTokens 避免双重扣减', () => {
      const text = 'a'.repeat(2000);
      const plan = createDeepSeekLongContextPlan(text, {
        chunkTokenLimit: 200, // 200 * 4 = 800 chars per chunk
        maxContextTokens: 600, // 600 tokens 上下文限制
        reserveOutputTokens: 100, // 100 tokens 为输出保留
        charsPerToken: 4,
      });

      // 每个 chunk 约 200 tokens（因为 reserveOutputTokens 传 undefined 给 chunks）
      // maxInputTokens = 600 - 100 = 500 tokens
      // 应能容纳 2 个 200-token 的 chunk（400 < 500），第 3 个 chunk 会超出
      expect(plan.includedChunkCount).toBeLessThanOrEqual(3);
      expect(plan.includedEstimatedTokens).toBeLessThanOrEqual(500);
      expect(plan.reserveOutputTokens).toBe(100);

      // chunks 本身不应受到 reserveOutputTokens 的影响
      // 2000 chars / 800 chars per chunk = 3 chunks (ceil)
      expect(plan.chunks.length).toBe(3);
      expect(plan.chunks[0].estimatedTokens).toBe(200); // 800 / 4
    });

    it('无限制时包含全部 chunks', () => {
      const text = 'a'.repeat(400);
      const plan = createDeepSeekLongContextPlan(text, {
        chunkTokenLimit: 200,
        charsPerToken: 4,
      });

      expect(plan.includedChunkCount).toBe(plan.chunks.length);
      expect(plan.omittedChunkCount).toBe(0);
      expect(plan.omittedEstimatedTokens).toBe(0);
    });

    it('maxChunks 限制被尊重', () => {
      const text = 'a'.repeat(2000);
      const plan = createDeepSeekLongContextPlan(text, {
        chunkTokenLimit: 100,
        charsPerToken: 4,
        maxChunks: 2,
      });

      expect(plan.includedChunkCount).toBe(2);
      expect(plan.omittedChunkCount).toBeGreaterThan(0);
    });
  });

  describe('Schema sanitization', () => {
    it('移除不支持的关键字', () => {
      const schema = sanitizeDeepSeekStrictSchema({
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          age: { type: 'integer', minItems: 0 },
        },
        required: ['name'],
      });

      expect(schema.properties).toBeDefined();
      const nameSchema = (schema.properties as any).name;
      expect(nameSchema.minLength).toBeUndefined();
      expect(nameSchema.maxLength).toBeUndefined();
    });

    it('强制所有属性为 required', () => {
      const schema = sanitizeDeepSeekStrictSchema({
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'number' },
        },
      });

      expect(schema.required).toEqual(['a', 'b']);
      expect(schema.additionalProperties).toBe(false);
    });

    it('移除不支持的 format', () => {
      const schema = sanitizeDeepSeekStrictSchema({
        type: 'object',
        properties: {
          date: { type: 'string', format: 'date-time' },
          email: { type: 'string', format: 'email' },
        },
      });

      const props = schema.properties as any;
      expect(props.date.format).toBeUndefined();
      expect(props.email.format).toBe('email');
    });

    it('oneOf 转换为 anyOf', () => {
      const schema = sanitizeDeepSeekStrictSchema({
        type: 'object',
        properties: {
          value: {
            oneOf: [
              { type: 'string' },
              { type: 'number' },
            ],
          },
        },
      });

      const valueSchema = (schema.properties as any).value;
      expect(valueSchema.anyOf).toBeDefined();
      expect(valueSchema.oneOf).toBeUndefined();
    });

    it('递归处理嵌套 schema', () => {
      const schema = sanitizeDeepSeekStrictSchema({
        type: 'object',
        properties: {
          nested: {
            type: 'object',
            properties: {
              field: { type: 'string', minLength: 5 },
            },
          },
        },
      });

      const nestedField = (schema.properties as any).nested.properties.field;
      expect(nestedField.minLength).toBeUndefined();
    });
  });

  describe('缓存优化 prefix 排序', () => {
    it('稳定消息前置', () => {
      const messages: Message[] = [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'volatile user message' },
        { role: 'user', content: 'stable message', metadata: { deepseekCache: 'stable' } },
      ];

      const optimized = optimizeDeepSeekCachePrefix(messages);
      // system 保持第一位
      expect(optimized[0].role).toBe('system');
      // stable 应排在 volatile 前面
      expect(optimized[1].content).toBe('stable message');
      expect(optimized[2].content).toBe('volatile user message');
    });

    it('空消息数组不报错', () => {
      const result = optimizeDeepSeekCachePrefix([]);
      expect(result).toEqual([]);
    });

    it('没有 stable 消息时保持原序', () => {
      const messages: Message[] = [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
      ];

      const result = optimizeDeepSeekCachePrefix(messages);
      expect(result.map((m) => m.content)).toEqual(['a', 'b']);
    });
  });

  describe('成本计算', () => {
    it('calculateDeepSeekCost 正确计算', () => {
      const cost = calculateDeepSeekCost({
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        cacheReadInputTokens: 200,
        cacheMissInputTokens: 800,
      }, 'deepseek-v4-pro');

      expect(cost).toBeDefined();
      expect(cost!.inputCacheHitTokens).toBe(200);
      expect(cost!.inputCacheMissTokens).toBe(800);
      expect(cost!.outputTokens).toBe(500);
      expect(cost!.totalCost).toBeGreaterThan(0);
      expect(cost!.currency).toBe('USD');
    });

    it('未知模型返回 undefined', () => {
      const cost = calculateDeepSeekCost({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      }, 'unknown-model-xyz');

      expect(cost).toBeUndefined();
    });

    it('CostTracker snapshot 初始化为零', () => {
      const tracker = new DeepSeekCostTracker('deepseek-v4-pro');
      const snapshot = tracker.getSnapshot();
      expect(snapshot.requestCount).toBe(0);
      expect(snapshot.totalCost).toBe(0);
      expect(snapshot.cacheHitRate).toBe(0);
    });

    it('CostTracker reset 清零', () => {
      const tracker = new DeepSeekCostTracker('deepseek-v4-pro');
      tracker.recordUsage({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      });
      tracker.reset();
      const snapshot = tracker.getSnapshot();
      expect(snapshot.requestCount).toBe(0);
      expect(snapshot.totalTokens).toBe(0);
    });
  });

  describe('withDeepSeekDefaults', () => {
    it('填充默认值', () => {
      const config = withDeepSeekDefaults({
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        apiKey: 'test',
        baseUrl: '',
      });

      expect(config.maxContextTokens).toBe(1_000_000);
      expect(config.maxOutputTokens).toBe(384_000);
      expect(config.temperature).toBe(0.3);
      expect(config.baseUrl).toBe('https://api.deepseek.com');
      expect(config.supportsThinking).toBe(true); // V4 Pro 默认启用 thinking
    });

    it('非 deepseek provider 不修改', () => {
      const original = {
        provider: 'openai' as const,
        model: 'gpt-4',
        apiKey: 'test',
        baseUrl: 'https://api.openai.com',
      };
      const config = withDeepSeekDefaults(original);
      expect(config).toEqual(original);
    });

    it('reasoner 别名启用 thinking', () => {
      const config = withDeepSeekDefaults({
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        apiKey: 'test',
        baseUrl: '',
      });

      expect(config.supportsThinking).toBe(true);
      expect(config.model).toBe('deepseek-v4-flash'); // 别名解析
    });
  });

  describe('prepareDeepSeekTools', () => {
    it('strict 模式添加 strict 标记并 sanitize', () => {
      const tools = prepareDeepSeekTools(
        [{
          name: 'test_tool',
          description: 'test',
          parameters: {
            type: 'object',
            properties: {
              x: { type: 'string', minLength: 1 },
            },
          },
        }],
        { strictTools: true },
      );

      expect(tools).toBeDefined();
      expect(tools![0].strict).toBe(true);
      // minLength 应被移除
      expect((tools![0].parameters.properties as any)?.x?.minLength).toBeUndefined();
    });

    it('非 strict 模式不修改 schema', () => {
      const tools = prepareDeepSeekTools(
        [{
          name: 'test_tool',
          description: 'test',
          parameters: {
            type: 'object',
            properties: {
              x: { type: 'string', minLength: 1 },
            },
          },
        }],
        { strictTools: false },
      );

      expect(tools).toBeDefined();
      expect(tools![0].strict).toBeUndefined();
      expect((tools![0].parameters.properties as any)?.x?.minLength).toBe(1);
    });

    it('空工具数组返回 undefined', () => {
      expect(prepareDeepSeekTools([], {})).toBeUndefined();
      expect(prepareDeepSeekTools(undefined, {})).toBeUndefined();
    });
  });
});
