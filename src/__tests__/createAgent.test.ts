import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { getSessionFilePathFromStorageRoot } from '../context/storage/pathUtils.js';
import type { Agent, AgentOptions } from '../index.js';
import type { SkillRegistry } from '../skills/SkillRegistry.js';
import type { PermissionHandler, PermissionHandlerRequest } from '../types/permissions.js';

const createRuntimeAgent = vi.fn(async (..._args: unknown[]) => ({
  async setModel() {},
  async *streamChat() {
    yield { type: 'turn_start' as const, turn: 1, maxTurns: 4 };
    yield { type: 'content_delta' as const, delta: 'Hello ' };
    yield { type: 'content_delta' as const, delta: 'world' };
    yield { type: 'turn_end' as const, turn: 1 };
    return {
      success: true,
      finalMessage: 'Hello world',
      metadata: {
        turnsCount: 1,
        toolCallsCount: 0,
        duration: 1,
      },
    };
  },
}));

vi.mock('../agent/Agent.js', () => ({
  Agent: {
    create: createRuntimeAgent,
  },
}));

const sdk = await import('../index.js');

describe('createAgent', () => {
  beforeEach(() => {
    createRuntimeAgent.mockClear();
  });

  it('creates an OpenAI-backed Agent from the minimal options', async () => {
    const agent = await sdk.createAgent({
      model: 'gpt-4o-mini',
      apiKey: 'test-key',
    });

    await expect(agent.supportedModels()).resolves.toEqual([
      {
        id: 'default',
        name: 'gpt-4o-mini',
        provider: 'openai',
      },
    ]);
    expect(createRuntimeAgent).toHaveBeenCalledOnce();
    expect(createRuntimeAgent.mock.calls.at(-1)?.[1]).toMatchObject({
      localDiscovery: false,
    });

    await agent.close();
  });

  it('maps common and advanced options without flattening the Session API', async () => {
    const onSessionStart = vi.fn(async () => ({ action: 'continue' as const }));
    const agent = await sdk.createAgent({
      model: 'deepseek-v4-pro',
      apiKey: 'deepseek-key',
      provider: 'deepseek',
      baseUrl: 'https://example.test/v1',
      temperature: 0.2,
      maxOutputTokens: 4096,
      maxTurns: 12,
      systemPrompt: 'Be precise.',
      advanced: {
        tokenBudget: { maxTotalTokens: 100_000 },
        hooks: {
          [sdk.HookEvent.SessionStart]: [onSessionStart],
        },
      },
    });

    const [config, runtimeOptions] = createRuntimeAgent.mock.calls.at(-1) ?? [];
    expect(config).toMatchObject({
      temperature: 0.2,
      models: [
        expect.objectContaining({
          provider: 'deepseek',
          model: 'deepseek-v4-pro',
          apiKey: 'deepseek-key',
          baseUrl: 'https://example.test/v1',
          maxOutputTokens: 4096,
        }),
      ],
    });
    expect(runtimeOptions).toMatchObject({
      maxTurns: 12,
      systemPrompt: 'Be precise.',
      tokenBudget: { maxTotalTokens: 100_000 },
    });
    expect(onSessionStart).toHaveBeenCalledOnce();

    await agent.close();
  });

  it('selects the local profile when filesystem access is configured', async () => {
    const agent = await sdk.createAgent({
      model: 'gpt-4o-mini',
      apiKey: 'test-key',
      filesystem: {
        roots: ['/workspace'],
        cwd: '/workspace',
      },
      advanced: {
        defaultContext: {
          environment: { APP_ENV: 'test' },
          metadata: { tenant: 'acme' },
        },
      },
    });

    expect(createRuntimeAgent.mock.calls.at(-1)?.[1]).toMatchObject({
      localDiscovery: true,
    });
    expect(agent.getDefaultContext()).toEqual({
      environment: { APP_ENV: 'test' },
      metadata: { tenant: 'acme' },
      capabilities: {
        filesystem: {
          roots: ['/workspace'],
          cwd: '/workspace',
        },
      },
    });

    await agent.close();
  });

  it('uses local JSONL persistence for a local profile with storagePath', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'create-agent-local-'));
    const storagePath = join(tempRoot, 'state');

    try {
      const agent = await sdk.createAgent({
        model: 'gpt-4o-mini',
        apiKey: 'test-key',
        profile: 'local',
        advanced: { storagePath },
      });

      expect(existsSync(getSessionFilePathFromStorageRoot(storagePath, agent.sessionId))).toBe(
        true,
      );
      await agent.close();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['default', sdk.PermissionMode.DEFAULT],
    ['accept-edits', sdk.PermissionMode.AUTO_EDIT],
    ['bypass-permissions', sdk.PermissionMode.YOLO],
    ['plan', sdk.PermissionMode.PLAN],
  ] as const)('maps the %s permission preset', async (permission, expectedMode) => {
    const agent = await sdk.createAgent({
      model: 'gpt-4o-mini',
      apiKey: 'test-key',
      advanced: { permission },
    });

    expect(createRuntimeAgent.mock.calls.at(-1)?.[1]).toMatchObject({
      permissionMode: expectedMode,
    });

    await agent.close();
  });

  it('normalizes custom permission decisions through the single permission field', async () => {
    const agent = await sdk.createAgent({
      model: 'gpt-4o-mini',
      apiKey: 'test-key',
      advanced: {
        permission: async (request) => (request.kind === sdk.ToolKind.ReadOnly ? 'allow' : 'deny'),
      },
    });

    const runtimeOptions = createRuntimeAgent.mock.calls.at(-1)?.[1] as {
      permissionMode: string;
      permissionHandler: PermissionHandler;
    };
    expect(runtimeOptions.permissionMode).toBe(sdk.PermissionMode.YOLO);

    const baseRequest: Omit<PermissionHandlerRequest, 'toolKind'> = {
      toolName: 'Read',
      input: {},
      signal: new AbortController().signal,
      affectedPaths: [],
      permissionMode: sdk.PermissionMode.YOLO,
      sessionApproved: false,
      toolMeta: {
        sideEffect: sdk.ToolSideEffect.PURE,
        isReadOnly: true,
        isConcurrencySafe: true,
        isDestructive: false,
      },
    };
    await expect(
      runtimeOptions.permissionHandler({
        ...baseRequest,
        toolKind: sdk.ToolKind.ReadOnly,
      }),
    ).resolves.toEqual({ behavior: 'allow' });
    await expect(
      runtimeOptions.permissionHandler({
        ...baseRequest,
        toolName: 'Write',
        toolKind: sdk.ToolKind.Write,
      }),
    ).resolves.toEqual({
      behavior: 'deny',
      message: 'Denied by permission policy',
    });

    await agent.close();
  });

  it('does not expose legacy permission fields in AgentOptions', () => {
    type AdvancedOptions = NonNullable<AgentOptions['advanced']>;

    expectTypeOf<AdvancedOptions>().not.toHaveProperty('permissionMode');
    expectTypeOf<AdvancedOptions>().not.toHaveProperty('permissionHandler');
    expectTypeOf<Agent>().not.toHaveProperty('stream');
  });

  it('does not forward legacy permission fields from untyped callers', async () => {
    const legacyPermissionHandler = vi.fn();
    const agent = await sdk.createAgent({
      model: 'gpt-4o-mini',
      apiKey: 'test-key',
      advanced: {
        permission: 'plan',
        permissionMode: sdk.PermissionMode.YOLO,
        permissionHandler: legacyPermissionHandler,
      } as never,
    });

    expect(createRuntimeAgent.mock.calls.at(-1)?.[1]).toMatchObject({
      permissionMode: sdk.PermissionMode.PLAN,
      permissionHandler: undefined,
    });

    await agent.close();
  });

  it('exposes one replayable response through text, textStream, on, and stream', async () => {
    const agent = await sdk.createAgent({
      model: 'gpt-4o-mini',
      apiKey: 'test-key',
    });

    const response = await agent.send('Say hello');
    const observed: string[] = [];
    response.on('content', (event) => {
      observed.push(event.delta);
    });

    await expect(response.text()).resolves.toBe('Hello world');

    const chunks: string[] = [];
    for await (const chunk of response.textStream()) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(['Hello ', 'world']);

    const eventTypes: string[] = [];
    for await (const event of response.stream()) {
      eventTypes.push(event.type);
    }
    expect(eventTypes).toEqual(['turn_start', 'content', 'content', 'turn_end', 'usage', 'result']);
    expect(observed).toEqual(['Hello ', 'world']);

    await agent.close();
  });

  it('injects data skills into isolated per-Agent registries', async () => {
    const first = await sdk.createAgent({
      model: 'gpt-4o-mini',
      apiKey: 'test-key',
      advanced: {
        skills: [
          {
            name: 'first-skill',
            description: 'First inline skill',
            content: 'Follow the first inline instructions.',
            allowedTools: ['Read'],
          },
        ],
      },
    });
    const firstDeps = createRuntimeAgent.mock.calls.at(-1)?.[2] as {
      skillRegistry: SkillRegistry;
    };

    const second = await sdk.createAgent({
      model: 'gpt-4o-mini',
      apiKey: 'test-key',
      advanced: {
        skills: [
          {
            name: 'second-skill',
            description: 'Second inline skill',
            content: 'Follow the second inline instructions.',
          },
        ],
      },
    });
    const secondDeps = createRuntimeAgent.mock.calls.at(-1)?.[2] as {
      skillRegistry: SkillRegistry;
    };

    expect(firstDeps.skillRegistry).not.toBe(secondDeps.skillRegistry);
    expect(firstDeps.skillRegistry.getAll().map((skill) => skill.name)).toEqual(['first-skill']);
    expect(secondDeps.skillRegistry.getAll().map((skill) => skill.name)).toEqual(['second-skill']);
    expect(firstDeps.skillRegistry.generateAvailableSkillsList()).toContain(
      'first-skill: First inline skill',
    );
    await expect(firstDeps.skillRegistry.loadContent('first-skill')).resolves.toMatchObject({
      instructions: 'Follow the first inline instructions.',
      metadata: {
        allowedTools: ['Read'],
      },
    });
    expect(firstDeps.skillRegistry.has('second-skill')).toBe(false);
    expect(secondDeps.skillRegistry.has('first-skill')).toBe(false);

    await first.close();
    await second.close();
  });
});
