/**
 * DeepSeek V4 Pro + Agent SDK 深度集成测试
 *
 * 验证 thinking 模型在 Agent 循环中的特殊行为：
 * - Thinking output 正确透传到 stream
 * - Thinking + Tool Use 组合的 token 管理
 * - temperature omit 在 Agent 层的正确性
 * - 复杂多轮 tool call 循环的稳定性
 * - 结构化输出 + thinking 模型的兼容
 *
 * 运行方式:
 *   DEEPSEEK_LIVE_TESTS=1 pnpm vitest run src/__tests__/deepseek-agent.live.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSession,
  defineTool,
  type ISession,
  PermissionMode,
  prompt,
  type StreamMessage,
  ToolErrorType,
} from '../index.js';

// ─── 配置 ─────────────────────────────────────────────────
const API_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
const LIVE = process.env.DEEPSEEK_LIVE_TESTS === '1';
const TIMEOUT = 120_000;

if (!LIVE || !API_KEY) {
  console.warn(
    '\n⚠️  DeepSeek Agent 深度测试需要 DEEPSEEK_LIVE_TESTS=1 和 DEEPSEEK_API_KEY\n',
  );
}

const describeDeepSeek = LIVE && API_KEY ? describe : describe.skip;

const PROVIDER = {
  type: 'deepseek' as const,
  apiKey: API_KEY || '',
  baseUrl: BASE_URL,
};

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    provider: PROVIDER,
    model: MODEL,
    permissionMode: PermissionMode.YOLO,
    maxTurns: 5,
    persistSession: false,
    ...overrides,
  };
}

async function drainStream(session: ISession, opts?: { includeThinking?: boolean }) {
  const events: StreamMessage[] = [];
  let content = '';
  let thinking = '';
  for await (const msg of session.stream(opts)) {
    events.push(msg);
    if (msg.type === 'content') content += msg.delta;
    if (msg.type === 'thinking') thinking += msg.delta;
  }
  return { events, content, thinking };
}

// ─── 清理 ───────────────────────────────────────────────
let activeSessions: ISession[] = [];
afterEach(async () => {
  for (const s of activeSessions) {
    try { await s.close(); } catch { /* ignore */ }
  }
  activeSessions = [];
});

// ═══════════════════════════════════════════════════════════
// 1. Thinking Output 透传
// ═══════════════════════════════════════════════════════════
describeDeepSeek('1. Thinking output 在 Agent 中的透传', () => {
  it('stream({ includeThinking: true }) 应返回 thinking delta', async () => {
    const session = await createSession(baseOptions());
    activeSessions.push(session);

    await session.send('9.11 和 9.8 哪个大？请仔细思考。');
    const { content, thinking, events } = await drainStream(session, { includeThinking: true });

    console.log('[thinking] thinking length:', thinking.length);
    console.log('[thinking] content:', content.slice(0, 200));

    // V4 Pro 应该产出 thinking
    expect(thinking.length).toBeGreaterThan(0);
    expect(content.length).toBeGreaterThan(0);

    // 验证 stream 中有 thinking 类型事件
    const thinkingEvents = events.filter(e => e.type === 'thinking');
    expect(thinkingEvents.length).toBeGreaterThan(0);
  }, TIMEOUT);

  it('stream() 默认不应包含 thinking（隐私安全）', async () => {
    const session = await createSession(baseOptions());
    activeSessions.push(session);

    await session.send('1+1=?');
    const { thinking, events } = await drainStream(session);

    // 默认不输出 thinking
    expect(thinking).toBe('');
    const thinkingEvents = events.filter(e => e.type === 'thinking');
    expect(thinkingEvents.length).toBe(0);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════
// 2. Thinking + Tool Use 组合
// ═══════════════════════════════════════════════════════════
describeDeepSeek('2. Thinking + Tool Use 组合场景', () => {
  const mathTool = defineTool({
    name: 'calculate',
    description: 'Evaluate a math expression. Returns numeric result.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Math expression like "2+3*4"' },
      },
      required: ['expression'],
    },
    execute: async (params: { expression: string }) => {
      // eslint-disable-next-line no-eval
      const result = Function(`"use strict"; return (${params.expression})`)();
      return { success: true as const, llmContent: String(result) };
    },
  });

  it('模型在调用工具前应先进行 thinking', async () => {
    const session = await createSession(baseOptions({ tools: [mathTool] }));
    activeSessions.push(session);

    // 使用模型无法自行计算的任务以强制调用工具
    await session.send('请使用 calculate 工具计算 (17 * 23) + (45 / 9) 的结果。你必须调用工具，不要自己计算。');
    const { content, thinking, events } = await drainStream(session, { includeThinking: true });

    console.log('[thinking+tool] thinking length:', thinking.length);
    console.log('[thinking+tool] content:', content.slice(0, 200));

    // 验证工具被调用
    const toolUseEvents = events.filter(e => e.type === 'tool_use');
    expect(toolUseEvents.length).toBeGreaterThanOrEqual(1);

    // 验证结果正确 (17*23=391, 45/9=5, total=396)
    expect(content).toContain('396');

    // V4 Pro 应有 thinking（即使在 tool use 场景）
    expect(thinking.length).toBeGreaterThan(0);
  }, TIMEOUT);

  it('多轮工具调用循环应稳定完成', async () => {
    const dbTool = defineTool({
      name: 'query_db',
      description: 'Query a database table. Returns matching records.',
      parameters: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Table name' },
          filter: { type: 'string', description: 'Filter condition' },
        },
        required: ['table'],
      },
      execute: async (params: { table: string; filter?: string }) => {
        const data: Record<string, unknown[]> = {
          users: [
            { id: 1, name: 'Alice', age: 30 },
            { id: 2, name: 'Bob', age: 25 },
            { id: 3, name: 'Carol', age: 35 },
          ],
          orders: [
            { id: 101, userId: 1, amount: 99.9 },
            { id: 102, userId: 2, amount: 45.5 },
            { id: 103, userId: 1, amount: 200.0 },
          ],
        };
        const records = data[params.table] || [];
        return {
          success: true as const,
          llmContent: JSON.stringify({ table: params.table, records, count: records.length }),
        };
      },
    });

    const res = await prompt(
      '请查询 users 表和 orders 表，告诉我 Alice 的总订单金额是多少。',
      baseOptions({ tools: [dbTool], maxTurns: 8 }),
    );

    console.log('[multi-turn-tool] tool calls:', res.toolCalls.map(tc => tc.name));
    console.log('[multi-turn-tool] result:', res.result.slice(0, 300));

    // 应该调用了至少2次工具（users + orders）
    expect(res.toolCalls.length).toBeGreaterThanOrEqual(2);

    // 结果应包含 Alice 的总金额 (99.9 + 200.0 = 299.9)
    expect(res.result).toMatch(/299\.?9/);
  }, TIMEOUT);

  it('工具返回错误时模型应优雅处理', async () => {
    const failTool = defineTool({
      name: 'unstable_api',
      description: 'An API that sometimes fails. Call it to get data.',
      parameters: {
        type: 'object',
        properties: {
          endpoint: { type: 'string' },
        },
        required: ['endpoint'],
      },
      execute: async (params: { endpoint: string }) => {
        if (params.endpoint === '/health') {
          return { success: true as const, llmContent: '{"status":"healthy","version":"2.1.0"}' };
        }
        return {
          success: false as const,
          llmContent: `API Error: endpoint "${params.endpoint}" returned 503 Service Unavailable`,
          error: {
            type: ToolErrorType.EXECUTION_ERROR,
            message: `API Error: endpoint "${params.endpoint}" returned 503 Service Unavailable`,
          },
        };
      },
    });

    const res = await prompt(
      '请调用 unstable_api 查询 /status 端点的信息，如果失败就尝试 /health 端点。',
      baseOptions({ tools: [failTool], maxTurns: 6 }),
    );

    console.log('[error-recovery] tool calls:', res.toolCalls.map(tc => `${tc.name}(${JSON.stringify(tc.input)})`));
    console.log('[error-recovery] result:', res.result.slice(0, 300));

    // 应该有至少2次工具调用（第一次失败，第二次成功）
    expect(res.toolCalls.length).toBeGreaterThanOrEqual(2);
    // 最终应包含 healthy 或 version 信息
    expect(res.result).toMatch(/healthy|2\.1\.0/i);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════
// 3. Token Budget 与 Thinking 的交互
// ═══════════════════════════════════════════════════════════
describeDeepSeek('3. Token budget 与 thinking 模型', () => {
  it('usage 应正确反映 thinking tokens', async () => {
    const session = await createSession(baseOptions());
    activeSessions.push(session);

    await session.send('解释为什么 0.1+0.2 不等于 0.3（简短回答）');
    const { events, content } = await drainStream(session);

    const usageEvents = events.filter(e => e.type === 'usage');
    expect(usageEvents.length).toBeGreaterThan(0);

    const usage = usageEvents[0];
    if (usage.type === 'usage') {
      console.log('[usage-thinking] tokens:', usage.usage);
      expect(usage.usage.inputTokens).toBeGreaterThan(0);
      expect(usage.usage.outputTokens).toBeGreaterThan(0);
      // thinking 模型的 outputTokens 应该比 content 字符数大（因为包含 reasoning tokens）
      expect(usage.usage.outputTokens).toBeGreaterThan(content.length / 4);
    }
  }, TIMEOUT);

  it('多轮对话中 token 累计应持续增长', async () => {
    const session = await createSession(baseOptions());
    activeSessions.push(session);

    // 第一轮
    await session.send('记住数字 7');
    const { events: e1 } = await drainStream(session);
    const u1 = e1.find(e => e.type === 'usage');

    // 第二轮
    await session.send('我说的数字是？');
    const { events: e2, content } = await drainStream(session);
    const u2 = e2.find(e => e.type === 'usage');

    expect(content).toContain('7');

    if (u1?.type === 'usage' && u2?.type === 'usage') {
      console.log('[token-growth] round1:', u1.usage.inputTokens, '| round2:', u2.usage.inputTokens);
      // 第二轮 inputTokens 应大于第一轮（上下文增长）
      expect(u2.usage.inputTokens).toBeGreaterThan(u1.usage.inputTokens);
    }
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════
// 4. 复杂工具场景（严格 Schema + 多参数）
// ═══════════════════════════════════════════════════════════
describeDeepSeek('4. 复杂工具 Schema 适配', () => {
  it('复杂嵌套参数应正确解析', async () => {
    const createTaskTool = defineTool({
      name: 'create_task',
      description: 'Create a project task with details.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Task title' },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          assignee: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              email: { type: 'string' },
            },
            required: ['name'],
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
          },
          dueDate: { type: 'string', description: 'ISO date string' },
        },
        required: ['title', 'priority', 'assignee'],
      },
      execute: async (params: Record<string, unknown>) => {
        return {
          success: true as const,
          llmContent: JSON.stringify({ id: 'TASK-001', created: true, ...params }),
        };
      },
    });

    const res = await prompt(
      '创建一个任务：标题"修复登录Bug"，优先级 critical，负责人 Zhang Wei (zhang@example.com)，标签 ["bug", "auth"]，截止日期 2024-12-31',
      baseOptions({ tools: [createTaskTool] }),
    );

    console.log('[complex-schema] tool calls:', JSON.stringify(res.toolCalls.map(tc => tc.input), null, 2));
    console.log('[complex-schema] result:', res.result.slice(0, 200));

    expect(res.toolCalls.length).toBeGreaterThanOrEqual(1);
    const toolInput = res.toolCalls[0].input as Record<string, unknown>;
    expect(toolInput.title).toBeDefined();
    expect(toolInput.priority).toBe('critical');
    expect(toolInput.assignee).toBeDefined();
  }, TIMEOUT);

  it('enum 参数应精确匹配约束值', async () => {
    const statusTool = defineTool({
      name: 'set_status',
      description: 'Set item status. Only accepts: draft, review, approved, rejected.',
      parameters: {
        type: 'object',
        properties: {
          itemId: { type: 'string' },
          status: { type: 'string', enum: ['draft', 'review', 'approved', 'rejected'] },
          reason: { type: 'string', description: 'Optional reason for status change' },
        },
        required: ['itemId', 'status'],
      },
      execute: async (params: { itemId: string; status: string; reason?: string }) => {
        return {
          success: true as const,
          llmContent: JSON.stringify({ updated: true, ...params }),
        };
      },
    });

    const res = await prompt(
      '将 item-123 的状态设为 approved，原因是"通过代码审查"',
      baseOptions({ tools: [statusTool] }),
    );

    expect(res.toolCalls.length).toBe(1);
    const input = res.toolCalls[0].input as Record<string, unknown>;
    expect(input.status).toBe('approved');
    expect(input.itemId).toContain('123');
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════
// 5. 结构化输出 + Thinking 模型
// ═══════════════════════════════════════════════════════════
describeDeepSeek('5. 结构化输出兼容性', () => {
  it('outputFormat JSON 应在 thinking 模型下正常工作', async () => {
    const res = await prompt(
      '列出3种编程语言及其主要用途，使用 JSON 格式回复',
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

    console.log('[structured+thinking] result:', res.result.slice(0, 300));

    // 验证输出是合法 JSON
    const jsonMatch = res.result.match(/\{[\s\S]*\}/);
    expect(jsonMatch).not.toBeNull();
    if (!jsonMatch) throw new Error('Expected JSON object in response');
    const parsed = JSON.parse(jsonMatch[0]);
    expect(parsed.languages).toBeDefined();
    expect(parsed.languages.length).toBeGreaterThanOrEqual(3);
    expect(parsed.languages[0].name).toBeDefined();
    expect(parsed.languages[0].use_case).toBeDefined();
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════
// 6. SystemPrompt 指令遵从性
// ═══════════════════════════════════════════════════════════
describeDeepSeek('6. 指令遵从与角色扮演', () => {
  it('应严格遵从 systemPrompt 的输出格式约束', async () => {
    const res = await prompt(
      '解释什么是 REST API',
      baseOptions({
        systemPrompt: '你是一个技术文档助手。所有回复必须遵循以下格式：\n## 定义\n[一句话定义]\n## 要点\n- 要点1\n- 要点2\n- 要点3\n\n不要添加任何其他内容。',
      }),
    );

    console.log('[instruction-follow] result:', res.result);

    // 验证格式遵从
    expect(res.result).toContain('## 定义');
    expect(res.result).toContain('## 要点');
    expect(res.result).toMatch(/- .+/); // 有列表项
  }, TIMEOUT);

  it('应在多轮中保持角色一致性', async () => {
    const session = await createSession(baseOptions({
      systemPrompt: '你是一个 JSON-only 回复机器人。所有回复必须是合法 JSON 对象，格式为 {"answer": "...", "confidence": 0.0-1.0}。不要输出任何非 JSON 内容。',
    }));
    activeSessions.push(session);

    // 第一轮
    await session.send('中国的首都是哪里？');
    const { content: c1 } = await drainStream(session);
    console.log('[role-consistency] round1:', c1);

    // 第二轮
    await session.send('地球到月球的距离大约是多少？');
    const { content: c2 } = await drainStream(session);
    console.log('[role-consistency] round2:', c2);

    // 两轮都应是 JSON
    const extractJson = (s: string) => {
      const match = s.match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : null;
    };

    const r1 = extractJson(c1);
    const r2 = extractJson(c2);
    expect(r1).not.toBeNull();
    expect(r1.answer).toBeDefined();
    expect(r2).not.toBeNull();
    expect(r2.answer).toBeDefined();
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════
// 7. 并发 & 边界情况
// ═══════════════════════════════════════════════════════════
describeDeepSeek('7. 并发与边界情况', () => {
  it('3 个并发 session 应独立完成', async () => {
    const tasks = ['计算 2*3', '计算 4*5', '计算 6*7'];
    const sessions = await Promise.all(
      tasks.map(() => createSession(baseOptions({ maxTurns: 3 }))),
    );
    activeSessions.push(...sessions);

    await Promise.all(
      tasks.map((task, i) => sessions[i].send(task)),
    );

    const results = await Promise.all(
      sessions.map(s => drainStream(s)),
    );

    console.log('[concurrent]', results.map(r => r.content.slice(0, 50)));

    expect(results[0].content).toContain('6');
    expect(results[1].content).toContain('20');
    expect(results[2].content).toContain('42');
  }, TIMEOUT);

  it('abort 应在 thinking 阶段也能中断', async () => {
    const session = await createSession(baseOptions());
    activeSessions.push(session);

    // 发送一个需要长时间 thinking 的任务
    await session.send('写一篇 500 字的短文，关于人工智能的未来');

    let chunkCount = 0;
    setTimeout(() => session.abort(), 2000); // 2 秒后中断

    let aborted = false;
    try {
      for await (const _msg of session.stream({ includeThinking: true })) {
        chunkCount++;
        if (chunkCount > 200) break; // 安全阀
      }
    } catch (e: unknown) {
      if (e instanceof Error && (e.message.includes('abort') || e.name === 'AbortError')) {
        aborted = true;
      }
    }

    console.log('[abort-thinking] chunks before abort:', chunkCount, 'aborted:', aborted);
    // 应该被中断（要么抛出 abort error，要么提前结束）
    expect(aborted || chunkCount < 200).toBe(true);
  }, TIMEOUT);
});
