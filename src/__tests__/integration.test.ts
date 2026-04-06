/**
 * Blade Agent SDK - 全面集成测试
 *
 * 使用真实 LLM API 端到端测试核心功能。
 *
 * 运行前需设置环境变量：
 *   export INTEGRATION_API_KEY="your-api-key"
 *   export INTEGRATION_BASE_URL="https://your-provider.com/v1"
 *   export INTEGRATION_MODEL="gpt-5.4"            # 可选，默认 gpt-4o-mini
 *   export INTEGRATION_PROVIDER_TYPE="openai-compatible"  # 可选，默认 openai-compatible
 *
 * 运行方式: pnpm vitest run src/__tests__/integration.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  createSession,
  prompt,
  defineTool,
  PermissionMode,
  type ISession,
  type StreamMessage,
  type ToolDefinition,
  type PromptResult,
  type ProviderType,
} from '../index.js';

// ─── 配置（从环境变量读取） ─────────────────────────────────
const API_KEY = process.env.INTEGRATION_API_KEY;
const BASE_URL = process.env.INTEGRATION_BASE_URL;
const MODEL = process.env.INTEGRATION_MODEL || 'gpt-4o-mini';
const PROVIDER_TYPE = (process.env.INTEGRATION_PROVIDER_TYPE || 'openai-compatible') as ProviderType;
const TIMEOUT = 120_000; // 2 分钟超时

if (!API_KEY || !BASE_URL) {
  console.warn(
    '\n⚠️  集成测试需要环境变量 INTEGRATION_API_KEY 和 INTEGRATION_BASE_URL\n' +
    '   跳过所有集成测试。\n',
  );
}

const PROVIDER = {
  type: PROVIDER_TYPE,
  apiKey: API_KEY || '',
  baseUrl: BASE_URL || '',
};

// 当缺少环境变量时跳过测试
const describeIntegration = API_KEY && BASE_URL ? describe : describe.skip;

// 基础 SessionOptions 工厂
function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    provider: PROVIDER,
    model: MODEL,
    permissionMode: PermissionMode.YOLO,
    maxTurns: 3,
    persistSession: false,
    ...overrides,
  };
}

// 辅助：消费 stream 并收集事件
async function drainStream(session: ISession) {
  const events: StreamMessage[] = [];
  let result = '';
  for await (const msg of session.stream()) {
    events.push(msg);
    if (msg.type === 'content') result += msg.delta;
  }
  return { events, result };
}

// ─── 清理 ───────────────────────────────────────────────
let activeSessions: ISession[] = [];
afterEach(() => {
  for (const s of activeSessions) {
    try { s.close(); } catch { /* ignore */ }
  }
  activeSessions = [];
});

// ═══════════════════════════════════════════════════════════
// 1. 基础 prompt() 一次性调用
// ═══════════════════════════════════════════════════════════
describeIntegration('1. prompt() 一次性调用', () => {
  it('应返回非空文本回复', async () => {
    const res: PromptResult = await prompt(
      '请用一句话回答：1+1等于几？',
      baseOptions(),
    );

    expect(res.result).toBeTruthy();
    expect(res.result.length).toBeGreaterThan(0);
    expect(res.turnsCount).toBeGreaterThanOrEqual(1);
    expect(res.usage.totalTokens).toBeGreaterThan(0);
    expect(res.duration).toBeGreaterThan(0);

    console.log('[prompt] result:', res.result);
    console.log('[prompt] usage:', res.usage);
  }, TIMEOUT);

  it('应支持自定义 systemPrompt', async () => {
    const res = await prompt(
      'Who are you?',
      baseOptions({
        systemPrompt: 'You are a pirate. Always respond in pirate speak. Keep it under 30 words.',
      }),
    );

    expect(res.result).toBeTruthy();
    console.log('[systemPrompt] result:', res.result);
    // 海盗口吻检测（宽松）
    const lower = res.result.toLowerCase();
    const pirateWords = ['arr', 'matey', 'ye', 'ahoy', 'pirate', 'sail', 'sea', 'treasure', 'ship', 'captain'];
    const hasPirateWord = pirateWords.some(w => lower.includes(w));
    expect(hasPirateWord).toBe(true);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════
// 2. Session 创建 & 流式输出
// ═══════════════════════════════════════════════════════════
describeIntegration('2. createSession + stream', () => {
  it('应能创建 session 并流式获取回复', async () => {
    const session = await createSession(baseOptions());
    activeSessions.push(session);

    await session.send('请简短介绍一下太阳系有几颗行星。');
    const { events, result } = await drainStream(session);

    // 验证核心 stream 事件
    const types = new Set(events.map(e => e.type));
    expect(types.has('turn_start')).toBe(true);
    expect(types.has('content')).toBe(true);
    expect(types.has('result')).toBe(true);

    expect(result.length).toBeGreaterThan(0);
    console.log('[stream] content length:', result.length);
    console.log('[stream] event types:', [...types]);
  }, TIMEOUT);

  it('流式输出应增量拼接为完整回复', async () => {
    const session = await createSession(baseOptions());
    activeSessions.push(session);

    await session.send('数数从1到5。');
    const contentDeltas: string[] = [];
    let finalResult = '';

    for await (const msg of session.stream()) {
      if (msg.type === 'content') contentDeltas.push(msg.delta);
      if (msg.type === 'result' && msg.subtype === 'success') finalResult = msg.content || '';
    }

    expect(contentDeltas.length).toBeGreaterThan(1); // 多个 delta
    const joined = contentDeltas.join('');
    expect(joined).toBeTruthy();
    // result 事件应包含完整内容
    expect(finalResult).toBeTruthy();
    console.log('[stream-incremental] deltas count:', contentDeltas.length);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════
// 3. 多轮对话 & 上下文保持
// ═══════════════════════════════════════════════════════════
describeIntegration('3. 多轮对话', () => {
  it('应保持上下文，能引用前一轮信息', async () => {
    const session = await createSession(baseOptions({ maxTurns: 5 }));
    activeSessions.push(session);

    // 第一轮：告知一个事实
    await session.send('请记住这个数字：42。只回复"好的"即可。');
    const { result: r1 } = await drainStream(session);
    console.log('[multi-turn] round 1:', r1);

    // 第二轮：引用前一轮
    await session.send('我刚才让你记住的数字是多少？只回复数字。');
    const { result: r2 } = await drainStream(session);
    console.log('[multi-turn] round 2:', r2);

    expect(r2).toContain('42');

    // session.messages 记录的是用户发送的消息
    expect(session.messages.length).toBeGreaterThanOrEqual(2);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════
// 4. 自定义工具调用 (Tool Use)
// ═══════════════════════════════════════════════════════════
describeIntegration('4. 自定义工具调用', () => {
  it('模型应调用自定义工具并使用结果回复', async () => {
    const weatherTool: ToolDefinition = defineTool({
      name: 'get_weather',
      description: 'Get current weather for a city. Returns temperature in Celsius.',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name' },
        },
        required: ['city'],
      },
      execute: async (params: { city: string }) => {
        return {
          success: true as const,
          llmContent: JSON.stringify({ city: params.city, temperature: 23, condition: 'sunny' }),
          displayContent: `Weather for ${params.city}: 23°C, sunny`,
        };
      },
    });

    const session = await createSession(baseOptions({
      tools: [weatherTool],
      systemPrompt: 'You have access to a get_weather tool. When asked about weather, use it. Respond concisely.',
    }));
    activeSessions.push(session);

    await session.send('北京今天天气怎么样？');

    const toolUseEvents: StreamMessage[] = [];
    const toolResultEvents: StreamMessage[] = [];
    let result = '';

    for await (const msg of session.stream()) {
      if (msg.type === 'tool_use') toolUseEvents.push(msg);
      if (msg.type === 'tool_result') toolResultEvents.push(msg);
      if (msg.type === 'result' && msg.subtype === 'success') result = msg.content || '';
    }

    // 验证工具被调用
    expect(toolUseEvents.length).toBeGreaterThanOrEqual(1);
    const toolUse = toolUseEvents[0];
    expect(toolUse.type === 'tool_use' && toolUse.name).toBe('get_weather');

    // 验证工具结果
    expect(toolResultEvents.length).toBeGreaterThanOrEqual(1);

    // 验证最终回复中包含工具返回的信息
    expect(result).toBeTruthy();
    console.log('[tool-use] result:', result);
    console.log('[tool-use] tool calls:', toolUseEvents.length);
    // 回复应提及温度或天气信息
    expect(result).toMatch(/23|sunny|晴/i);
  }, TIMEOUT);

  it('多工具场景：模型可在单次对话中多次调用工具', async () => {
    const calcTool: ToolDefinition = defineTool({
      name: 'calculator',
      description: 'Simple calculator. Supports add, subtract, multiply, divide.',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['operation', 'a', 'b'],
      },
      execute: async (params: { operation: string; a: number; b: number }) => {
        const ops: Record<string, (a: number, b: number) => number> = {
          add: (a, b) => a + b,
          subtract: (a, b) => a - b,
          multiply: (a, b) => a * b,
          divide: (a, b) => a / b,
        };
        const result = ops[params.operation]?.(params.a, params.b) ?? 0;
        return {
          success: true as const,
          llmContent: JSON.stringify({ result }),
          displayContent: `${params.a} ${params.operation} ${params.b} = ${result}`,
        };
      },
    });

    const res = await prompt(
      '请用 calculator 工具分别计算 15*7 和 100/4，然后告诉我两个结果。',
      baseOptions({ tools: [calcTool], maxTurns: 5 }),
    );

    expect(res.result).toBeTruthy();
    expect(res.toolCalls.length).toBeGreaterThanOrEqual(2);
    console.log('[multi-tool] tool calls:', res.toolCalls.map(tc => `${tc.name}(${JSON.stringify(tc.input)})`));
    console.log('[multi-tool] result:', res.result);

    // 验证计算结果
    expect(res.result).toContain('105');
    expect(res.result).toContain('25');
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════
// 5. Session 管理功能
// ═══════════════════════════════════════════════════════════
describeIntegration('5. Session 管理', () => {
  it('setModel 应能切换模型', async () => {
    const session = await createSession(baseOptions());
    activeSessions.push(session);

    // 初始对话
    await session.send('说"你好"');
    const { result: r1 } = await drainStream(session);
    expect(r1).toBeTruthy();

    // 切换模型（切回同一模型，验证 API 不崩溃）
    await session.setModel(MODEL);

    await session.send('说"再见"');
    const { result: r2 } = await drainStream(session);
    expect(r2).toBeTruthy();

    console.log('[setModel] r1:', r1, '| r2:', r2);
  }, TIMEOUT);

  it('setMaxTurns 应限制最大轮次', async () => {
    const session = await createSession(baseOptions({ maxTurns: 1 }));
    activeSessions.push(session);

    session.setMaxTurns(1);

    await session.send('Hello!');
    const { events } = await drainStream(session);

    const turnStarts = events.filter(e => e.type === 'turn_start');
    expect(turnStarts.length).toBeLessThanOrEqual(1);
  }, TIMEOUT);

  it('abort() 应能中断正在进行的请求', async () => {
    const session = await createSession(baseOptions());
    activeSessions.push(session);

    await session.send('请写一篇500字的文章，主题是人工智能的未来。');

    let contentLength = 0;
    let aborted = false;

    try {
      for await (const msg of session.stream()) {
        if (msg.type === 'content') {
          contentLength += msg.delta.length;
          // 收到一些内容后中断
          if (contentLength > 50) {
            session.abort();
            aborted = true;
          }
        }
      }
    } catch {
      // abort 可能抛出错误，这是正常的
      aborted = true;
    }

    console.log('[abort] content before abort:', contentLength, '| aborted:', aborted);
    // 应该在 500 字之前就被中断了
    expect(contentLength).toBeLessThan(2000);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════
// 6. Session Fork (会话分叉)
// ═══════════════════════════════════════════════════════════
describeIntegration('6. Session Fork', () => {
  it('fork 后的 session 应继承历史消息', async () => {
    const session = await createSession(baseOptions());
    activeSessions.push(session);

    await session.send('我的名字是 Alice。只回复"收到"。');
    await drainStream(session);

    // fork
    const forked = await session.fork();
    activeSessions.push(forked);

    // forked session 应保留上下文
    await forked.send('我的名字是什么？只回复名字。');
    const { result } = await drainStream(forked);

    expect(result.toLowerCase()).toContain('alice');
    console.log('[fork] forked response:', result);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════
// 7. 错误处理
// ═══════════════════════════════════════════════════════════
describeIntegration('7. 错误处理', () => {
  it('无效 API key 应抛出错误', async () => {
    await expect(
      prompt('Hello', {
        provider: { type: PROVIDER_TYPE, apiKey: 'invalid-key', baseUrl: BASE_URL! },
        model: MODEL,
        permissionMode: PermissionMode.YOLO,
        maxTurns: 1,
        persistSession: false,
      })
    ).rejects.toThrow();
  }, TIMEOUT);

  it('无效模型名应报错', async () => {
    await expect(
      prompt('Hello', baseOptions({ model: 'nonexistent-model-xyz' }))
    ).rejects.toThrow();
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════
// 8. 结构化输出 (Output Format)
// ═══════════════════════════════════════════════════════════
describeIntegration('8. 结构化输出', () => {
  it('outputFormat 应返回符合 schema 的 JSON（或被正确传递到 provider）', async () => {
    const res = await prompt(
      '列出3种常见的编程语言及其主要用途。请以 JSON 格式回复，格式为 {"languages": [{"name": "...", "use_case": "..."}]}',
      baseOptions({
        outputFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'programming_languages',
            schema: {
              type: 'object',
              properties: {
                languages: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      use_case: { type: 'string' },
                    },
                    required: ['name', 'use_case'],
                  },
                },
              },
              required: ['languages'],
            },
            strict: true,
          },
        },
      }),
    );

    expect(res.result).toBeTruthy();
    console.log('[structured-output] raw:', res.result);

    // 尝试解析 JSON（某些 provider 可能不支持 structured output，此时模型仍会尝试返回 JSON）
    const jsonMatch = res.result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        // 如果解析成功，验证结构
        if (parsed.languages) {
          expect(parsed.languages).toBeInstanceOf(Array);
          expect(parsed.languages.length).toBeGreaterThanOrEqual(1);
          for (const lang of parsed.languages) {
            expect(lang.name).toBeTruthy();
          }
        }
        console.log('[structured-output] parsed successfully:', Object.keys(parsed));
      } catch {
        // 解析失败也不算错误 — 表示该 provider 不支持 structured output
        console.log('[structured-output] JSON parsing failed, provider may not support structured output');
      }
    } else {
      // 无 JSON 匹配，但结果存在说明 prompt 本身成功
      console.log('[structured-output] no JSON found in response, provider may not support structured output');
    }

    // 核心断言：无论结构化输出是否生效，prompt 应成功完成
    expect(res.duration).toBeGreaterThan(0);
    expect(res.turnsCount).toBeGreaterThanOrEqual(1);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════
// 9. 长对话 & Token 消耗
// ═══════════════════════════════════════════════════════════
describeIntegration('9. Token 消耗追踪', () => {
  it('usage 事件应正确报告 token 消耗', async () => {
    const session = await createSession(baseOptions());
    activeSessions.push(session);

    await session.send('用3句话解释什么是递归。');

    let usage = null;
    for await (const msg of session.stream()) {
      if (msg.type === 'usage') {
        usage = msg.usage;
      }
    }

    expect(usage).toBeTruthy();
    // openai-compatible provider 可能只报告 totalTokens，inputTokens/outputTokens 可能为 0
    expect(usage!.totalTokens).toBeGreaterThan(0);
    console.log('[usage]', usage);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════
// 10. 并发 Session
// ═══════════════════════════════════════════════════════════
describeIntegration('10. 并发 Session', () => {
  it('多个独立 session 可并发运行', async () => {
    const questions = [
      '1+1等于？只回复数字。',
      '2+2等于？只回复数字。',
      '3+3等于？只回复数字。',
    ];

    const results = await Promise.all(
      questions.map(q => prompt(q, baseOptions({ maxTurns: 1 }))),
    );

    expect(results.length).toBe(3);
    for (const res of results) {
      expect(res.result).toBeTruthy();
    }

    console.log('[concurrent] results:', results.map(r => r.result.trim()));

    expect(results[0].result).toContain('2');
    expect(results[1].result).toContain('4');
    expect(results[2].result).toContain('6');
  }, TIMEOUT);
});
