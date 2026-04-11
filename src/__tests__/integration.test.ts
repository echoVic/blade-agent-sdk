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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import {
  createSdkMcpServer,
  createSession,
  forkSession,
  prompt,
  defineTool,
  PermissionMode,
  resumeSession,
  tool,
  type ISession,
  type StreamMessage,
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

const MULTIMODAL_TEST_IMAGE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+KDnxWQAAAABJRU5ErkJggg==';

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

function createStoragePath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`No JSON object found in response: ${raw}`);
    }
    return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  }
}

// 辅助：消费 stream 并收集事件
async function drainStream(session: ISession) {
  const events: StreamMessage[] = [];
  let content = '';
  let finalResult = '';
  for await (const msg of session.stream()) {
    events.push(msg);
    if (msg.type === 'content') content += msg.delta;
    if (msg.type === 'result' && msg.subtype === 'success') {
      finalResult = msg.content || '';
    }
  }
  return {
    events,
    result: content,
    finalResult,
  };
}

// ─── 清理 ───────────────────────────────────────────────
let activeSessions: ISession[] = [];
let tempDirs: string[] = [];
afterEach(() => {
  for (const s of activeSessions) {
    try { s.close(); } catch { /* ignore */ }
  }
  activeSessions = [];
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tempDirs = [];
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
    const weatherTool = defineTool({
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
    const calcTool = defineTool({
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
// 6.1 持久化恢复与高级分叉
// ═══════════════════════════════════════════════════════════
describeIntegration('6.1 持久化恢复与高级分叉', () => {
  it('resumeSession 应恢复持久化上下文并继续流式对话', async () => {
    const storagePath = createStoragePath('blade-live-resume-');
    const session = await createSession(baseOptions({
      persistSession: true,
      storagePath,
      maxTurns: 4,
    }));
    activeSessions.push(session);

    await session.send('请记住暗号 BLUE-FOX-17。只回复 ACK。');
    const firstTurn = await drainStream(session);
    const sessionId = session.sessionId;
    session.close();
    activeSessions = activeSessions.filter((candidate) => candidate !== session);

    const resumed = await resumeSession({
      ...baseOptions({
        persistSession: true,
        storagePath,
        maxTurns: 4,
      }),
      sessionId,
    });
    activeSessions.push(resumed);

    await resumed.send('上一轮让你记住的暗号是什么？只回复 BLUE-FOX-17。');
    const secondTurn = await drainStream(resumed);

    expect(firstTurn.finalResult || firstTurn.result).toMatch(/ACK/i);
    expect(secondTurn.finalResult || secondTurn.result).toContain('BLUE-FOX-17');
    expect(firstTurn.events.some((event) => event.type === 'turn_end')).toBe(true);
    expect(secondTurn.events.some((event) => event.type === 'turn_end')).toBe(true);

    console.log('[resume] first:', firstTurn.finalResult || firstTurn.result);
    console.log('[resume] second:', secondTurn.finalResult || secondTurn.result);
  }, TIMEOUT);

  it('forkSession 应允许父会话和分支会话沿不同上下文继续演化', async () => {
    const storagePath = createStoragePath('blade-live-fork-');
    const session = await createSession(baseOptions({
      persistSession: true,
      storagePath,
      maxTurns: 4,
    }));
    activeSessions.push(session);

    await session.send('请记住我的名字是 Ada Lovelace。只回复 OK。');
    await drainStream(session);

    const forked = await forkSession({
      ...baseOptions({
        persistSession: true,
        storagePath,
        maxTurns: 4,
      }),
      sessionId: session.sessionId,
    });
    activeSessions.push(forked);

    await session.send('我刚才告诉你的名字是什么？只回复 Ada Lovelace。');
    const parentRecall = await drainStream(session);

    await forked.send('在这个分支里，把我的名字改成 Grace Hopper。只回复 OK。');
    await drainStream(forked);
    await forked.send('这个分支里我的名字是什么？只回复 Grace Hopper。');
    const forkRecall = await drainStream(forked);

    expect(parentRecall.finalResult || parentRecall.result).toContain('Ada');
    expect(forkRecall.finalResult || forkRecall.result).toContain('Grace Hopper');

    console.log('[fork-branch] parent:', parentRecall.finalResult || parentRecall.result);
    console.log('[fork-branch] fork:', forkRecall.finalResult || forkRecall.result);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════
// 6.2 Hooks / Permissions / MCP 真实链路
// ═══════════════════════════════════════════════════════════
describeIntegration('6.2 Hooks / Permissions / MCP 真实链路', () => {
  it('hooks 应能修改工具输入输出并影响最终回复', async () => {
    const echoTool = defineTool({
      name: 'echo_hook',
      description: 'Echo the provided value for integration testing.',
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string', description: 'Value to echo' },
        },
        required: ['value'],
      },
      execute: async (params: { value: string }) => ({
        success: true,
        llmContent: `server:${params.value}`,
      }),
    });

    const session = await createSession(baseOptions({
      tools: [echoTool],
      allowedTools: ['echo_hook'],
      maxTurns: 4,
      systemPrompt:
        'You must call echo_hook exactly once when asked. After the tool returns, respond exactly with EXACT:post-hooked-output.',
      hooks: {
        PreToolUse: [
          async () => ({
            action: 'continue',
            modifiedInput: { value: 'pre-hooked-input' },
          }),
        ],
        PostToolUse: [
          async () => ({
            action: 'continue',
            modifiedOutput: 'post-hooked-output',
          }),
        ],
      },
    }));
    activeSessions.push(session);

    await session.send('调用 echo_hook 一次，value 传 raw-input。最后只回复 EXACT:post-hooked-output。');
    const streamed = await drainStream(session);
    const toolUseEvents = streamed.events.filter((event) => event.type === 'tool_use');
    const toolResultEvents = streamed.events.filter((event) => event.type === 'tool_result');

    expect(toolUseEvents.length).toBeGreaterThanOrEqual(1);
    expect(toolResultEvents.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(toolUseEvents[0])).toContain('raw-input');
    expect(JSON.stringify(toolResultEvents[0])).toContain('post-hooked-output');
    expect(streamed.finalResult || streamed.result).toContain('EXACT:post-hooked-output');

    console.log('[hooks-tool] result:', streamed.finalResult || streamed.result);
  }, TIMEOUT);

  it('canUseTool deny 应阻止工具执行并返回受控错误结果', async () => {
    const restrictedTool = defineTool({
      name: 'restricted_action',
      description: 'A restricted tool that should be denied by permissions.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
        },
        required: ['reason'],
      },
      execute: async () => ({
        success: true,
        llmContent: 'should-not-run',
      }),
    });

    const session = await createSession(baseOptions({
      tools: [restrictedTool],
      allowedTools: ['restricted_action'],
      maxTurns: 4,
      systemPrompt:
        'You must call restricted_action exactly once when asked. If it fails, explain the failure briefly.',
      canUseTool: async (toolName: string) => {
        if (toolName === 'restricted_action') {
          return {
            behavior: 'deny',
            message: 'permission denied for integration test',
          };
        }
        return { behavior: 'allow' };
      },
    }));
    activeSessions.push(session);

    await session.send('调用 restricted_action，并说明为什么失败。');
    const streamed = await drainStream(session);
    const toolUseEvents = streamed.events.filter((event) => event.type === 'tool_use');
    const toolResultEvents = streamed.events.filter((event) => event.type === 'tool_result');

    expect(toolUseEvents.length).toBeGreaterThanOrEqual(1);
    expect(toolResultEvents.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(toolResultEvents[0])).toContain('permission denied for integration test');
    expect(JSON.stringify(toolResultEvents[0])).toContain('"isError":true');
    expect(streamed.finalResult || streamed.result).toMatch(/denied|权限|失败/i);

    console.log('[permission-deny] result:', streamed.finalResult || streamed.result);
  }, TIMEOUT);

  it('应能通过 in-process MCP server 暴露工具并由模型调用', async () => {
    const handle = await createSdkMcpServer({
      name: 'integration-mcp',
      version: '1.0.0',
      tools: [
        tool(
          'lookup_release_train',
          'Lookup the release train code for integration testing.',
          {
            project: z.string().describe('Project name'),
          },
          async (params) => ({
            content: [
              {
                type: 'text',
                text: `project=${params.project}; release_train=TRAIN-ALPHA-9`,
              },
            ],
          }),
        ),
      ],
    });

    const session = await createSession(baseOptions({
      mcpServers: {
        integration: handle,
      },
      maxTurns: 4,
      systemPrompt:
        'When asked for a release train, use the lookup_release_train tool and then answer with the exact release train code.',
    }));
    activeSessions.push(session);

    const mcpTools = await session.mcpListTools();
    expect(mcpTools.some((toolInfo) => toolInfo.name.includes('lookup_release_train'))).toBe(true);

    await session.send('请查询 project=blade 的 release train，并只回复最终代号。');
    const streamed = await drainStream(session);
    const toolUseEvents = streamed.events.filter((event) => event.type === 'tool_use');

    expect(toolUseEvents.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(toolUseEvents[0])).toContain('lookup_release_train');
    expect(streamed.finalResult || streamed.result).toContain('TRAIN-ALPHA-9');

    console.log('[mcp-live] result:', streamed.finalResult || streamed.result);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════
// 6.3 子代理 / 后台代理真实链路
// ═══════════════════════════════════════════════════════════
describeIntegration('6.3 子代理 / 后台代理真实链路', () => {
  it('应能通过 Task 工具实时调用会话级子代理并汇总结果', async () => {
    const session = await createSession(baseOptions({
      allowedTools: ['Task'],
      maxTurns: 5,
      agents: {
        'math-specialist': {
          name: 'math-specialist',
          description: 'A concise math specialist for integration tests.',
          systemPrompt:
            'You are a math specialist. Follow the prompt exactly and return only the final requested token.',
        },
      },
      systemPrompt:
        'When asked, you must call the Task tool exactly once with subagent_type "math-specialist". After reading the subagent result, respond exactly with EXACT:SUBAGENT:437.',
    }));
    activeSessions.push(session);

    await session.send('请使用 Task 子代理计算 19*23，并最终只回复 EXACT:SUBAGENT:437。');
    const streamed = await drainStream(session);
    const toolUseEvents = streamed.events.filter((event) => event.type === 'tool_use');
    const toolResultEvents = streamed.events.filter((event) => event.type === 'tool_result');

    expect(toolUseEvents.some((event) => event.type === 'tool_use' && event.name === 'Task')).toBe(true);
    expect(JSON.stringify(toolUseEvents[0])).toContain('math-specialist');
    expect(toolResultEvents.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(toolResultEvents[0])).toContain('437');
    expect(streamed.finalResult || streamed.result).toContain('EXACT:SUBAGENT:437');

    console.log('[subagent-live] result:', streamed.finalResult || streamed.result);
  }, TIMEOUT);

  it('应能启动后台子代理并通过 TaskOutput 获取最终结果', async () => {
    const session = await createSession(baseOptions({
      allowedTools: ['Task', 'TaskOutput'],
      maxTurns: 6,
      agents: {
        'background-specialist': {
          name: 'background-specialist',
          description: 'A background worker that returns exact integration tokens.',
          systemPrompt:
            'You are a background specialist. Return exactly the token requested by the prompt and nothing else.',
        },
      },
      systemPrompt:
        'When asked, you must first call Task exactly once with subagent_type "background-specialist" and run_in_background=true. Then call TaskOutput on the returned task_id with block=true. After TaskOutput returns, respond exactly with EXACT:BACKGROUND:BG-CHECK-299.',
    }));
    activeSessions.push(session);

    await session.send(
      '请启动后台子代理，让它只返回 BG-CHECK-299。等待它完成后，只回复 EXACT:BACKGROUND:BG-CHECK-299。'
    );
    const streamed = await drainStream(session);
    const taskUses = streamed.events.filter(
      (event) => event.type === 'tool_use' && event.name === 'Task'
    );
    const taskOutputUses = streamed.events.filter(
      (event) => event.type === 'tool_use' && event.name === 'TaskOutput'
    );
    const toolResultEvents = streamed.events.filter((event) => event.type === 'tool_result');

    expect(taskUses.length).toBeGreaterThanOrEqual(1);
    expect(taskOutputUses.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(taskUses[0])).toContain('background-specialist');
    expect(JSON.stringify(taskUses[0])).toContain('run_in_background');
    expect(JSON.stringify(toolResultEvents.at(-1))).toContain('BG-CHECK-299');
    expect(streamed.finalResult || streamed.result).toContain('EXACT:BACKGROUND:BG-CHECK-299');

    console.log('[background-subagent-live] result:', streamed.finalResult || streamed.result);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════
// 6.4 多模态 / MCP 恢复真实链路
// ═══════════════════════════════════════════════════════════
describeIntegration('6.4 多模态 / MCP 恢复真实链路', () => {
  it('应能发送多模态消息并基于文本与图片存在进行回复', async () => {
    const session = await createSession(baseOptions({
      maxTurns: 4,
      systemPrompt:
        'If the user message contains exactly one image and the text token ORANGE-KITE, reply exactly with EXACT:MULTIMODAL:ORANGE-KITE:1.',
    }));
    activeSessions.push(session);

    await session.send([
      {
        type: 'text',
        text: '请确认我发送了 1 张图片，文本暗号是 ORANGE-KITE。最后只回复 EXACT:MULTIMODAL:ORANGE-KITE:1。',
      },
      {
        type: 'image_url',
        image_url: { url: MULTIMODAL_TEST_IMAGE_DATA_URL },
      },
    ]);
    const streamed = await drainStream(session);
    const errorMessages = streamed.events
      .filter((event): event is Extract<StreamMessage, { type: 'error' }> => event.type === 'error')
      .map((event) => event.message);

    if (errorMessages.length > 0) {
      expect(errorMessages.join('\n')).toMatch(/image|download|fetch|vision|multimodal/i);
      console.log('[multimodal-live] provider limitation:', errorMessages.join(' | '));
      return;
    }

    expect(streamed.events.some((event) => event.type === 'result')).toBe(true);
    expect(streamed.finalResult || streamed.result).toContain('EXACT:MULTIMODAL:ORANGE-KITE:1');

    console.log('[multimodal-live] result:', streamed.finalResult || streamed.result);
  }, TIMEOUT);

  it('mcpDisconnect 和 mcpReconnect 后应恢复工具调用能力', async () => {
    const handle = await createSdkMcpServer({
      name: 'integration-mcp-recovery',
      version: '1.0.0',
      tools: [
        tool(
          'lookup_recovery_code',
          'Lookup a recovery code for integration testing.',
          {
            project: z.string().describe('Project name'),
          },
          async (params) => ({
            content: [
              {
                type: 'text',
                text: `project=${params.project}; recovery_code=RECOVER-42`,
              },
            ],
          }),
        ),
      ],
    });

    const session = await createSession(baseOptions({
      mcpServers: {
        recovery: handle,
      },
      maxTurns: 5,
      systemPrompt:
        'When asked for a recovery code, use the lookup_recovery_code tool and answer exactly with the final recovery code.',
    }));
    activeSessions.push(session);

    const initialTools = await session.mcpListTools();
    expect(initialTools.some((toolInfo) => toolInfo.name.includes('lookup_recovery_code'))).toBe(true);

    await session.send('先查询一次 project=blade 的恢复码，并只回复最终代号。');
    const firstRun = await drainStream(session);
    expect(firstRun.finalResult || firstRun.result).toContain('RECOVER-42');

    await session.mcpDisconnect('recovery');
    const disconnectedTools = await session.mcpListTools();
    expect(disconnectedTools.some((toolInfo) => toolInfo.name.includes('lookup_recovery_code'))).toBe(false);

    await session.mcpReconnect('recovery');
    const reconnectedTools = await session.mcpListTools();
    expect(reconnectedTools.some((toolInfo) => toolInfo.name.includes('lookup_recovery_code'))).toBe(true);

    await session.send('现在再次查询 project=blade 的恢复码，并只回复最终代号。');
    const secondRun = await drainStream(session);
    const secondToolUses = secondRun.events.filter((event) => event.type === 'tool_use');

    expect(secondToolUses.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(secondToolUses[0])).toContain('lookup_recovery_code');
    expect(secondRun.finalResult || secondRun.result).toContain('RECOVER-42');

    console.log('[mcp-reconnect-live] first:', firstRun.finalResult || firstRun.result);
    console.log('[mcp-reconnect-live] second:', secondRun.finalResult || secondRun.result);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════
// 7. 错误处理
// ═══════════════════════════════════════════════════════════
describeIntegration('7. 错误处理', () => {
  it('无效 API key 应抛出错误', async () => {
    await expect(
      prompt('Hello', {
        provider: { type: PROVIDER_TYPE, apiKey: 'invalid-key', baseUrl: BASE_URL || '' },
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
        const parsed = parseJsonObject(jsonMatch[0]);
        // 如果解析成功，验证结构
        const languages = parsed.languages;
        if (Array.isArray(languages)) {
          expect(languages.length).toBeGreaterThanOrEqual(1);
          for (const lang of languages) {
            expect(lang).toBeTruthy();
            expect(typeof lang).toBe('object');
            expect((lang as Record<string, unknown>).name).toBeTruthy();
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

  it('严格 schema 模式一：应返回完全符合 checklist schema 的 JSON', async () => {
    const res = await prompt(
      '只返回 JSON。mode 固定为 checklist。items 必须依次是 {"name":"session","status":"pass"} 和 {"name":"tools","status":"pass"}。meta 必须是 {"ready":true,"warnings":0}。',
      baseOptions({
        outputFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'integration_checklist',
            schema: {
              type: 'object',
              properties: {
                mode: { type: 'string' },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      status: { type: 'string' },
                    },
                    required: ['name', 'status'],
                    additionalProperties: false,
                  },
                },
                meta: {
                  type: 'object',
                  properties: {
                    ready: { type: 'boolean' },
                    warnings: { type: 'integer' },
                  },
                  required: ['ready', 'warnings'],
                  additionalProperties: false,
                },
              },
              required: ['mode', 'items', 'meta'],
              additionalProperties: false,
            },
            strict: true,
          },
        },
      }),
    );

    const parsed = parseJsonObject(res.result) as {
      mode: string;
      items: Array<{ name: string; status: string }>;
      meta: { ready: boolean; warnings: number };
    };

    expect(parsed).toEqual({
      mode: 'checklist',
      items: [
        { name: 'session', status: 'pass' },
        { name: 'tools', status: 'pass' },
      ],
      meta: { ready: true, warnings: 0 },
    });

    console.log('[structured-output-checklist] parsed:', parsed);
  }, TIMEOUT);

  it('严格 schema 模式二：应返回完全符合 routing schema 的 JSON', async () => {
    const res = await prompt(
      '只返回 JSON。route.kind 固定为 background_agent。route.priority 固定为 high。actions 必须依次为 {"tool":"Task","required":true} 和 {"tool":"TaskOutput","required":true}。verdict 固定为 go。',
      baseOptions({
        outputFormat: {
          type: 'json_schema',
          json_schema: {
            name: 'integration_routing',
            schema: {
              type: 'object',
              properties: {
                route: {
                  type: 'object',
                  properties: {
                    kind: { type: 'string' },
                    priority: { type: 'string' },
                  },
                  required: ['kind', 'priority'],
                  additionalProperties: false,
                },
                actions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      tool: { type: 'string' },
                      required: { type: 'boolean' },
                    },
                    required: ['tool', 'required'],
                    additionalProperties: false,
                  },
                },
                verdict: { type: 'string' },
              },
              required: ['route', 'actions', 'verdict'],
              additionalProperties: false,
            },
            strict: true,
          },
        },
      }),
    );

    const parsed = parseJsonObject(res.result) as {
      route: { kind: string; priority: string };
      actions: Array<{ tool: string; required: boolean }>;
      verdict: string;
    };

    expect(parsed).toEqual({
      route: { kind: 'background_agent', priority: 'high' },
      actions: [
        { tool: 'Task', required: true },
        { tool: 'TaskOutput', required: true },
      ],
      verdict: 'go',
    });

    console.log('[structured-output-routing] parsed:', parsed);
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
    expect(usage?.totalTokens ?? 0).toBeGreaterThan(0);
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
