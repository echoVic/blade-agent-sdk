import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolDefinition } from '../../tools/types/index.js';
import { PermissionMode } from '../../types/common.js';
import { HookEvent } from '../../types/constants.js';
import type { SessionOptions } from '../types.js';

const mockConnect = mock(() => Promise.resolve());
const mockDisconnect = mock(() => Promise.resolve());
const mockOn = mock(() => {});

mock.module('../../mcp/McpClient.js', () => ({
  McpClient: class MockMcpClient {
    availableTools = [
      {
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
        },
      },
    ];
    connect = mockConnect;
    disconnect = mockDisconnect;
    on = mockOn;
  },
}));

const { SessionRuntime } = await import('../SessionRuntime.js');

const customTool: ToolDefinition<{ value?: string }> = {
  name: 'CustomTool',
  description: 'Custom test tool',
  parameters: {
    type: 'object',
    properties: {
      value: { type: 'string' },
    },
  },
  async execute() {
    return {
      success: true,
      llmContent: 'ok',
      displayContent: 'ok',
    };
  },
};

function createOptions(overrides: Partial<SessionOptions> = {}): SessionOptions {
  return {
    provider: { type: 'openai-compatible', apiKey: 'test-key' },
    model: 'gpt-4o-mini',
    ...overrides,
  };
}

describe('SessionRuntime', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'session-runtime-test-'));
    mockConnect.mockClear();
    mockDisconnect.mockClear();
    mockOn.mockClear();
  });

  afterEach(async () => {
    const runtime = new SessionRuntime(
      'cleanup',
      createOptions(),
      {
        models: [],
      },
      PermissionMode.DEFAULT,
      workspaceRoot,
    );
    await runtime.close();
  });

  it('should apply allowedTools/disallowedTools to the runtime registry', async () => {
    const runtime = new SessionRuntime(
      'session-1',
      createOptions({
        allowedTools: ['Read', 'CustomTool'],
        disallowedTools: ['Read'],
        tools: [customTool],
      }),
      {
        models: [],
      },
      PermissionMode.DEFAULT,
      workspaceRoot,
    );

    await runtime.initialize();

    const toolNames = runtime.getToolRegistry().getAll().map((tool) => tool.name);
    expect(toolNames).toEqual(['CustomTool']);

    await runtime.close();
  });

  it('should refresh MCP tools on disconnect and reconnect', async () => {
    const runtime = new SessionRuntime(
      'session-2',
      createOptions({
        mcpServers: {
          test: { command: 'echo' },
        },
      }),
      {
        models: [],
        currentModelId: 'default',
      },
      PermissionMode.DEFAULT,
      workspaceRoot,
    );

    await runtime.initialize();
    expect((await runtime.mcpListTools()).map((tool) => tool.name)).toEqual(['test_tool']);
    expect(runtime.getToolRegistry().get('test_tool')).toBeDefined();

    await runtime.mcpDisconnect('test');
    expect(await runtime.mcpListTools()).toEqual([]);
    expect(runtime.getToolRegistry().get('test_tool')).toBeUndefined();

    await runtime.mcpReconnect('test');
    expect((await runtime.mcpListTools()).map((tool) => tool.name)).toEqual(['test_tool']);
    expect(runtime.getToolRegistry().get('test_tool')).toBeDefined();

    await runtime.close();
  });

  it('should apply session hook callbacks to tool execution', async () => {
    const execute = mock(async (params: { value?: string }) => ({
      success: true,
      llmContent: params.value || 'missing',
      displayContent: params.value || 'missing',
    }));

    const runtime = new SessionRuntime(
      'session-3',
      createOptions({
        tools: [
          {
            ...customTool,
            execute,
          },
        ],
        hooks: {
          [HookEvent.PreToolUse]: [
            async () => ({
              action: 'continue',
              modifiedInput: { value: 'from-pre-hook' },
            }),
          ],
          [HookEvent.PostToolUse]: [
            async () => ({
              action: 'continue',
              modifiedOutput: 'from-post-hook',
            }),
          ],
        },
      }),
      {
        models: [],
      },
      PermissionMode.DEFAULT,
      workspaceRoot,
    );

    await runtime.initialize();

    const result = await runtime.getAgentRuntimeDeps().executionPipeline!.execute(
      'CustomTool',
      { value: 'original' },
      { sessionId: 'session-3', workspaceRoot },
    );

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'from-pre-hook' }),
      expect.anything(),
    );
    expect(result.success).toBe(true);
    expect(result.llmContent).toBe('from-post-hook');

    await runtime.close();
  });

  it('should let permission hooks modify input before canUseTool runs', async () => {
    const canUseTool = mock(async (_toolName: string, input: Record<string, unknown>) => ({
      behavior: 'allow' as const,
      updatedInput: input,
    }));
    const execute = mock(async (params: { value?: string }) => ({
      success: true,
      llmContent: params.value || 'missing',
      displayContent: params.value || 'missing',
    }));

    const runtime = new SessionRuntime(
      'session-4',
      createOptions({
        canUseTool,
        tools: [
          {
            ...customTool,
            execute,
          },
        ],
        hooks: {
          [HookEvent.PermissionRequest]: [
            async () => ({
              action: 'continue',
              modifiedInput: { value: 'from-permission-hook' },
            }),
          ],
        },
      }),
      {
        models: [],
      },
      PermissionMode.DEFAULT,
      workspaceRoot,
    );

    await runtime.initialize();

    const result = await runtime.getAgentRuntimeDeps().executionPipeline!.execute(
      'CustomTool',
      { value: 'original' },
      { sessionId: 'session-4', workspaceRoot },
    );

    expect(canUseTool).toHaveBeenCalledWith(
      'CustomTool',
      expect.objectContaining({ value: 'from-permission-hook' }),
      expect.objectContaining({ affectedPaths: [] }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'from-permission-hook' }),
      expect.anything(),
    );
    expect(result.llmContent).toBe('from-permission-hook');

    await runtime.close();
  });

  it('should apply post-tool-failure hooks to failed tool results', async () => {
    const runtime = new SessionRuntime(
      'session-5',
      createOptions({
        tools: [
          {
            ...customTool,
            async execute() {
              throw new Error('boom');
            },
          },
        ],
        hooks: {
          [HookEvent.PostToolUseFailure]: [
            async () => ({
              action: 'continue',
              modifiedOutput: 'hook-adjusted-error',
            }),
          ],
        },
      }),
      {
        models: [],
      },
      PermissionMode.DEFAULT,
      workspaceRoot,
    );

    await runtime.initialize();

    const result = await runtime.getAgentRuntimeDeps().executionPipeline!.execute(
      'CustomTool',
      { value: 'original' },
      { sessionId: 'session-5', workspaceRoot },
    );

    expect(result.success).toBe(false);
    expect(result.llmContent).toBe('hook-adjusted-error');

    await runtime.close();
  });
});
