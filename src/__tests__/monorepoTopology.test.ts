import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageJson {
  name?: string;
  private?: boolean;
  main?: string;
  types?: string;
  workspaces?: unknown;
  exports?: Record<string, unknown>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  compilerOptions?: {
    rootDir?: string;
    declarationMap?: boolean;
    paths?: Record<string, string[]>;
  };
  files?: string[];
  include?: string[];
  exclude?: string[];
  publishConfig?: Record<string, unknown>;
}

function readJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, 'utf-8')) as PackageJson;
}

describe('monorepo topology', () => {
  it('keeps legacy root source free of workspace path aliases', () => {
    const files = [
      'src/session/SessionStore.ts',
      'src/tools/types/ExecutionTypes.ts',
    ];

    for (const file of files) {
      const source = readFileSync(file, 'utf-8');

      expect(source, `${file} should use explicit relative imports`).not.toMatch(
        /(?:from|import)\s*\(?['"]@\//,
      );
    }
  });

  it('declares packages workspace and keeps root as a private orchestrator', () => {
    const root = readJson('package.json');
    const workspace = readFileSync('pnpm-workspace.yaml', 'utf-8');

    expect(root.private).toBe(true);
    expect(root.main).toBeUndefined();
    expect(root.types).toBeUndefined();
    expect(root.exports).toBeUndefined();
    expect(root.files).toBeUndefined();
    expect(root.publishConfig).toBeUndefined();
    expect(root.dependencies).toBeUndefined();
    expect(root.optionalDependencies).toBeUndefined();
    expect(workspace).toContain('packages:');
    expect(workspace).toContain("'packages/*'");
  });

  it('keeps root build orchestration out of root dist output', () => {
    const root = readJson('package.json');

    expect(root.scripts?.build).toBe('pnpm --filter @blade-ai/agent-sdk run build');
    expect(root.scripts?.build).not.toContain('tsup');
    expect(root.scripts?.build).not.toContain('tsconfig.build.json');
  });

  it('does not keep obsolete root package build configs', () => {
    expect(existsSync('tsup.config.ts')).toBe(false);
    expect(existsSync('tsconfig.build.json')).toBe(false);
  });

  it('contains ai, agent, and agent-sdk packages with source entrypoints', () => {
    const expectedPackages = [
      ['packages/ai', '@blade-ai/ai'],
      ['packages/agent', '@blade-ai/agent'],
      ['packages/agent-sdk', '@blade-ai/agent-sdk'],
    ] as const;

    for (const [dir, name] of expectedPackages) {
      expect(existsSync(join(dir, 'package.json')), `${dir}/package.json`).toBe(true);
      expect(existsSync(join(dir, 'src/index.ts')), `${dir}/src/index.ts`).toBe(true);
      expect(readJson(join(dir, 'package.json')).name).toBe(name);
    }
  });

  it('exposes package metadata subpaths for every publishable package', () => {
    for (const [dir, packageJsonPath] of [
      ['packages/ai', './package.json'],
      ['packages/agent', './package.json'],
      ['packages/agent-sdk', './package.json'],
    ] as const) {
      const pkg = readJson(join(dir, 'package.json'));

      expect(pkg.exports?.['./package.json'], `${dir} ./package.json export`).toEqual({
        default: packageJsonPath,
      });
    }
  });

  it('makes agent-sdk depend on ai and agent through workspace protocol', () => {
    const sdk = readJson('packages/agent-sdk/package.json');

    expect(sdk.dependencies).toMatchObject({
      '@blade-ai/agent': 'workspace:*',
      '@blade-ai/ai': 'workspace:*',
    });
  });

  it('keeps legacy session kernel adapters on explicit agent package subpaths', () => {
    const adapterImports = [
      [
        'src/session/SessionKernelAdapter.ts',
        ["from '@blade-ai/agent/ports'", "from '@blade-ai/agent/protocol'"],
      ],
      ['src/session/SessionKernelStoreAdapter.ts', ["from '@blade-ai/agent/state'"]],
      ['src/session/SessionKernelTraceAdapter.ts', ["from '@blade-ai/agent/tracing'"]],
      ['src/session/SessionKernelHookAdapter.ts', ["from '@blade-ai/agent/ports'"]],
    ] as const;

    for (const [file, requiredImports] of adapterImports) {
      const source = readFileSync(file, 'utf-8');

      expect(source, `${file} should not rely on the agent root barrel`).not.toContain(
        "from '@blade-ai/agent'",
      );

      for (const requiredImport of requiredImports) {
        expect(source, `${file} should import ${requiredImport}`).toContain(requiredImport);
      }
    }
  });

  it('keeps legacy root session runtime on explicit agent package subpaths', () => {
    const rootTsconfig = readJson('tsconfig.json');
    const sessionModelPortSource = readFileSync('src/session/SessionModelPort.ts', 'utf-8');
    const files = [
      'src/session/SessionRuntime.ts',
      'src/session/SessionModelPort.ts',
      'src/session/__tests__/SessionKernelAdapter.test.ts',
      'src/session/__tests__/SessionKernelStoreAdapter.test.ts',
      'src/session/__tests__/SessionKernelTraceAdapter.test.ts',
    ];

    expect(rootTsconfig.compilerOptions?.paths).toMatchObject({
      '@blade-ai/agent/kernel': ['./packages/agent/src/kernel/AgentKernel.ts'],
      '@blade-ai/agent/ports': ['./packages/agent/src/ports/index.ts'],
      '@blade-ai/agent/protocol': ['./packages/agent/src/protocol/index.ts'],
      '@blade-ai/agent/state': ['./packages/agent/src/state/index.ts'],
      '@blade-ai/agent/tracing': ['./packages/agent/src/tracing/index.ts'],
    });

    for (const file of files) {
      const source = readFileSync(file, 'utf-8');

      expect(source, `${file} should not rely on the agent root barrel`).not.toContain(
        "from '@blade-ai/agent'",
      );
    }

    expect(sessionModelPortSource).toContain("from '@blade-ai/ai/deepseek'");
    expect(sessionModelPortSource).not.toContain("from '../services/deepseek.js'");
  });

  it('keeps legacy root model management on ai provider helper subpaths', () => {
    const modelManagerSource = readFileSync('src/agent/ModelManager.ts', 'utf-8');

    expect(modelManagerSource).toContain("from '@blade-ai/ai/deepseek'");
    expect(modelManagerSource).not.toContain("from '../services/deepseek.js'");
  });

  it('keeps the legacy root DeepSeek service as an ai package re-export shim', () => {
    const deepseekServiceSource = readFileSync('src/services/deepseek.ts', 'utf-8').trim();

    expect(deepseekServiceSource).toBe("export * from '@blade-ai/ai/deepseek';");
  });

  it('keeps root context chat protocol types on the ai chat subpath', () => {
    const files = [
      'src/context/ContextManager.ts',
      'src/context/FileAnalyzer.ts',
      'src/context/TokenCounter.ts',
      'src/context/CompactionService.ts',
      'src/context/storage/PersistentStore.ts',
      'src/context/strategies/MicrocompactStrategy.ts',
      'src/context/strategies/SoftCompactionStrategy.ts',
      'src/context/__tests__/TokenCounter.test.ts',
      'src/context/__tests__/CompactionService.test.ts',
      'src/context/strategies/__tests__/MicrocompactStrategy.test.ts',
      'src/context/strategies/__tests__/SoftCompactionStrategy.test.ts',
    ];

    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      const legacyChatServiceImports =
        source.match(/import[\s\S]*?from ['"][^'"]*services\/ChatServiceInterface\.js['"];?/g)
        ?? [];

      expect(source, `${file} should import chat protocol types from ai`).toContain(
        "from '@blade-ai/ai/chat'",
      );

      if (file === 'src/context/CompactionService.ts') {
        expect(source, `${file} should import the session chat service factory`).toContain(
          "from '../session/ChatServiceFactory.js'",
        );
        expect(legacyChatServiceImports, `${file} should not import the legacy factory shim`)
          .toHaveLength(0);
        expect(legacyChatServiceImports.join('\n'), `${file} should not import Message from root`)
          .not.toMatch(/\btype\s+Message\b/);
        continue;
      }

      expect(
        legacyChatServiceImports,
        `${file} should not import chat protocol types from root services`,
      ).toHaveLength(0);
    }
  });

  it('keeps root agent chat protocol types on the ai chat subpath', () => {
    const files = [
      'src/agent/Agent.ts',
      'src/agent/AgentEvent.ts',
      'src/agent/AttachmentHandler.ts',
      'src/agent/CompactionHandler.ts',
      'src/agent/LoopHookBuilder.ts',
      'src/agent/LoopRunner.ts',
      'src/agent/ModelManager.ts',
      'src/agent/RuntimePatchManager.ts',
      'src/agent/types.ts',
      'src/agent/loop/adapterContracts.ts',
      'src/agent/loop/runTurn.ts',
      'src/agent/state/ConversationState.ts',
      'src/agent/state/LoopState.ts',
      'src/agent/state/TurnState.ts',
      'src/agent/subagents/AgentSessionStore.ts',
      'src/agent/subagents/BackgroundAgentManager.ts',
      'src/agent/__tests__/AgentLoop.test.ts',
      'src/agent/__tests__/AgentLoop.streaming.test.ts',
      'src/agent/__tests__/CompactionHandler.test.ts',
      'src/agent/__tests__/LoopRunner.test.ts',
      'src/agent/__tests__/LoopState.test.ts',
      'src/agent/__tests__/ModelManager.setModel.test.ts',
      'src/agent/__tests__/decideTurnLimit.singleWriter.test.ts',
      'src/agent/__tests__/skillActivationFiltering.test.ts',
      'src/agent/state/__tests__/ConversationState.test.ts',
    ];

    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      const legacyChatServiceImports =
        source.match(/import[\s\S]*?from ['"][^'"]*services\/ChatServiceInterface\.js['"];?/g)
        ?? [];

      expect(source, `${file} should import chat protocol types from ai`).toContain(
        "from '@blade-ai/ai/chat'",
      );

      if (file === 'src/agent/ModelManager.ts') {
        expect(source, `${file} should import the session chat service factory`).toContain(
          "from '../session/ChatServiceFactory.js'",
        );
        expect(legacyChatServiceImports, `${file} should not import the legacy factory shim`)
          .toHaveLength(0);
        expect(legacyChatServiceImports.join('\n'), `${file} should not import IChatService from root`)
          .not.toMatch(/\btype\s+IChatService\b/);
        continue;
      }

      expect(
        legacyChatServiceImports,
        `${file} should not import chat protocol types from root services`,
      ).toHaveLength(0);
    }
  });

  it('keeps the legacy root function tool-call type as an agent loop alias', () => {
    const legacyToolCallTypeSource = readFileSync('src/agent/loop/types.ts', 'utf-8');
    const packagePlanToolSource = readFileSync('packages/agent/src/loop/planToolExecution.ts', 'utf-8');
    const rootFunctionToolCallConsumers = [
      'src/agent/loop/adapterContracts.ts',
      'src/agent/loop/runToolCall.ts',
      'src/agent/loop/runTurn.ts',
      'src/agent/loop/toolUpdateToAgentEvent.ts',
    ];

    expect(legacyToolCallTypeSource.trim()).toBe(
      "export type { AgentFunctionToolCall as FunctionToolCall } from '@blade-ai/agent/loop';",
    );
    expect(packagePlanToolSource).toContain('export interface AgentFunctionToolCall');

    for (const file of rootFunctionToolCallConsumers) {
      const source = readFileSync(file, 'utf-8');

      expect(source, `${file} should consume function tool-call protocol from agent loop`).toContain(
        "from '@blade-ai/agent/loop'",
      );
      expect(source, `${file} should not import the legacy root loop type shim`).not.toMatch(
        /from ['"][^'"]*loop\/types\.js['"]|from ['"]\.\/types\.js['"]/,
      );
    }
  });

  it('keeps the legacy root token budget as an agent package shim', () => {
    const tokenBudgetSource = readFileSync('src/agent/TokenBudget.ts', 'utf-8');
    const packageTokenBudgetSource = readFileSync('packages/agent/src/budget/TokenBudget.ts', 'utf-8');
    const rootTokenBudgetConsumers = [
      'src/agent/Agent.ts',
      'src/agent/AgentEvent.ts',
      'src/agent/LoopHookBuilder.ts',
      'src/agent/LoopRunner.ts',
      'src/agent/loop/adapterContracts.ts',
      'src/agent/types.ts',
      'src/session/types.ts',
      'src/index.ts',
      'src/agent/__tests__/TokenBudget.test.ts',
    ];

    expect(tokenBudgetSource.trim()).toBe(
      [
        "export { TokenBudget } from '@blade-ai/agent/budget';",
        "export type { TokenBudgetConfig, TokenBudgetSnapshot } from '@blade-ai/agent/budget';",
      ].join('\n'),
    );
    expect(packageTokenBudgetSource).toContain('export class TokenBudget');
    expect(packageTokenBudgetSource).toContain('isDiminishingReturns');
    expect(packageTokenBudgetSource).toContain('shouldCompact');

    for (const file of rootTokenBudgetConsumers) {
      const source = readFileSync(file, 'utf-8');

      expect(source, `${file} should consume token budget from the agent package`).toContain(
        "from '@blade-ai/agent/budget'",
      );
      expect(source, `${file} should not import the legacy root token budget shim`).not.toMatch(
        /from ['"][^'"]*TokenBudget\.js['"]/,
      );
    }
  });

  it('keeps root session chat protocol types on the ai chat subpath', () => {
    const files = [
      'src/session/Session.ts',
      'src/session/SessionStore.ts',
      'src/session/types.ts',
      'src/session/__tests__/SessionContext.test.ts',
      'src/session/__tests__/SessionPersistence.test.ts',
      'src/session/__tests__/SessionStore.test.ts',
    ];

    for (const file of files) {
      const source = readFileSync(file, 'utf-8');

      expect(source, `${file} should import chat protocol types from ai`).toContain(
        "from '@blade-ai/ai/chat'",
      );
      expect(
        source.match(/import[\s\S]*?from ['"][^'"]*services\/ChatServiceInterface\.js['"];?/g)
          ?? [],
        `${file} should not import chat protocol types from root services`,
      ).toHaveLength(0);
    }
  });

  it('keeps root hooks and tool result chat protocol types on the ai chat subpath', () => {
    const files = [
      'src/hooks/HookRuntime.ts',
      'src/hooks/__tests__/HookRuntime.test.ts',
      'src/tools/types/ToolEffects.ts',
      'src/tools/types/ToolResult.ts',
    ];

    for (const file of files) {
      const source = readFileSync(file, 'utf-8');

      expect(source, `${file} should import chat protocol types from ai`).toContain(
        "from '@blade-ai/ai/chat'",
      );
      expect(
        source.match(/import[\s\S]*?from ['"][^'"]*services\/ChatServiceInterface\.js['"];?/g)
          ?? [],
        `${file} should not import chat protocol types from root services`,
      ).toHaveLength(0);
    }
  });

  it('keeps root service implementation chat protocol types on the ai chat subpath', () => {
    const files = [
      'src/session/VercelAIChatService.ts',
      'src/runtime/messageUtils.ts',
      'src/services/__tests__/deepseek-deep.live.test.ts',
    ];

    for (const file of files) {
      const source = readFileSync(file, 'utf-8');
      const legacyChatServiceImports =
        source.match(/import[\s\S]*?from ['"][^'"]*ChatServiceInterface\.js['"];?/g) ?? [];

      expect(source, `${file} should import chat protocol types from ai`).toContain(
        "from '@blade-ai/ai/chat'",
      );

      if (file.endsWith('.live.test.ts')) {
        expect(source, `${file} should import the session chat service factory`).toContain(
          "from '../../session/ChatServiceFactory.js'",
        );
        expect(legacyChatServiceImports, `${file} should not import the legacy factory shim`)
          .toHaveLength(0);
        expect(legacyChatServiceImports.join('\n'), `${file} should not import Message from root`)
          .not.toMatch(/\btype\s+Message\b/);
        continue;
      }

      expect(
        legacyChatServiceImports,
        `${file} should not import chat protocol types from root services`,
      ).toHaveLength(0);
    }
  });

  it('keeps legacy root message utilities as a runtime shim', () => {
    const legacyMessageUtilsSource = readFileSync('src/services/messageUtils.ts', 'utf-8');
    const runtimeMessageUtilsSource = readFileSync('src/runtime/messageUtils.ts', 'utf-8');
    const runtimeConsumers = [
      'src/session/Session.ts',
      'src/session/SessionStore.ts',
      'src/hooks/HookRuntime.ts',
      'src/agent/CompactionHandler.ts',
    ];

    expect(legacyMessageUtilsSource.trim()).toBe(
      "export { cloneContentPart, cloneJsonValue, cloneMessage, cloneToolCall } from '../runtime/messageUtils.js';",
    );
    expect(runtimeMessageUtilsSource).toContain("from '@blade-ai/ai/chat'");
    expect(runtimeMessageUtilsSource).toContain("from '../types/common.js'");
    expect(runtimeMessageUtilsSource).toContain('export function cloneMessage');

    for (const file of runtimeConsumers) {
      const source = readFileSync(file, 'utf-8');

      expect(source, `${file} should import message clone helpers from runtime`).toContain(
        "from '../runtime/messageUtils.js'",
      );
      expect(source, `${file} should not import the legacy root message utils shim`).not.toContain(
        '../services/messageUtils.js',
      );
    }
  });

  it('keeps the legacy root chat service interface as a session factory shim', () => {
    const chatServiceInterfaceSource = readFileSync('src/services/ChatServiceInterface.ts', 'utf-8');
    const chatServiceFactorySource = readFileSync('src/session/ChatServiceFactory.ts', 'utf-8');
    const importSites = [
      ['src/agent/ModelManager.ts', 'import'],
      ['src/context/CompactionService.ts', 'import'],
      ['src/services/__tests__/deepseek.live.test.ts', 'import'],
      ['src/services/__tests__/deepseek-deep.live.test.ts', 'import'],
      ['src/agent/__tests__/ModelManager.setModel.test.ts', 'mock'],
      ['src/context/__tests__/CompactionService.test.ts', 'mock'],
    ] as const;

    expect(chatServiceInterfaceSource.trim()).toBe(
      "export { createChatServiceAsync } from '../session/ChatServiceFactory.js';",
    );
    expect(chatServiceInterfaceSource).not.toContain('VercelAIChatService');
    expect(chatServiceFactorySource).toContain('function createChatServiceAsync');
    expect(chatServiceFactorySource).toContain("from './VercelAIChatService.js'");
    expect(
      chatServiceInterfaceSource,
      'legacy root service path must not be a chat protocol type source',
    ).not.toMatch(/export\s+type\s+\{[\s\S]*?\}\s+from\s+['"]@blade-ai\/ai\/chat['"]/);

    for (const [file, mode] of importSites) {
      const source = readFileSync(file, 'utf-8');

      if (mode === 'mock') {
        expect(source, `${file} should mock the session factory export`).toContain(
          '../session/ChatServiceFactory.js',
        );
        expect(
          source.match(/import[\s\S]*?from ['"][^'"]*ChatServiceInterface\.js['"];?/g) ?? [],
          `${file} should not import chat protocol types from root services`,
        ).toHaveLength(0);
        continue;
      }

      const imports =
        source.match(/import[\s\S]*?from ['"][^'"]*ChatServiceFactory\.js['"];?/g) ?? [];

      expect(imports, `${file} should import the session factory exactly once`).toHaveLength(1);
      expect(imports[0], `${file} should only import createChatServiceAsync`).toMatch(
        /\{\s*createChatServiceAsync\s*\}/,
      );
      expect(imports[0], `${file} should not import chat protocol types`).not.toMatch(
        /\btype\s+(?:ChatConfig|ChatResponse|IChatService|Message|StreamChunk|UsageInfo)\b/,
      );
      expect(source, `${file} should not import the legacy chat service shim`).not.toContain(
        'ChatServiceInterface.js',
      );
    }
  });

  it('keeps the legacy root Vercel chat service as a session implementation shim', () => {
    const legacyServiceSource = readFileSync('src/services/VercelAIChatService.ts', 'utf-8');
    const sessionServiceSource = readFileSync('src/session/VercelAIChatService.ts', 'utf-8');
    const serviceTestSource = readFileSync('src/services/__tests__/VercelAIChatService.test.ts', 'utf-8');

    expect(legacyServiceSource.trim()).toBe(
      "export { VercelAIChatService } from '../session/VercelAIChatService.js';",
    );
    expect(sessionServiceSource).toContain('export class VercelAIChatService');
    expect(sessionServiceSource).toContain("from '@blade-ai/ai/providers/vercel'");
    expect(sessionServiceSource).toContain("from '@blade-ai/ai/retry'");
    expect(serviceTestSource).toContain("await import('../../session/VercelAIChatService.js')");
    expect(serviceTestSource).not.toContain("await import('../VercelAIChatService.js')");
  });

  it('keeps the legacy root retry policy as an ai package shim', () => {
    const legacyRetrySource = readFileSync('src/services/RetryPolicy.ts', 'utf-8');
    const retryConsumers = [
      'src/session/VercelAIChatService.ts',
      'src/services/__tests__/RetryPolicy.test.ts',
      'src/agent/__tests__/AgentLoop.test.ts',
    ];

    expect(legacyRetrySource.trim()).toBe("export * from '@blade-ai/ai/retry';");

    for (const file of retryConsumers) {
      const source = readFileSync(file, 'utf-8');

      expect(source, `${file} should import retry contracts from ai`).toContain(
        "from '@blade-ai/ai/retry'",
      );
      expect(source, `${file} should not import the legacy root retry shim`).not.toMatch(
        /from ['"][^'"]*services\/RetryPolicy\.js['"]|from ['"][^'"]*RetryPolicy\.js['"]/,
      );
    }
  });

  it('keeps root integration tests on public agent-sdk subpaths', () => {
    const integrationTestSource = readFileSync('src/__tests__/integration.test.ts', 'utf-8');
    const rootTsconfigSource = readFileSync('tsconfig.json', 'utf-8');
    const vitestConfigSource = readFileSync('vitest.config.ts', 'utf-8');

    expect(integrationTestSource).toContain("from '@blade-ai/agent-sdk/local'");
    expect(integrationTestSource).not.toContain('../../packages/agent-sdk/src');
    expect(rootTsconfigSource).toContain('"@blade-ai/agent-sdk/local"');
    expect(vitestConfigSource).toContain("'@blade-ai/agent-sdk/local'");
  });

  it('keeps root package entrypoint tests on public agent-sdk subpaths', () => {
    const packageEntrypointsSource = readFileSync('src/__tests__/packageEntrypoints.test.ts', 'utf-8');
    const rootTsconfigSource = readFileSync('tsconfig.json', 'utf-8');
    const vitestConfigSource = readFileSync('vitest.config.ts', 'utf-8');

    expect(packageEntrypointsSource).toContain("from '@blade-ai/agent-sdk'");
    expect(packageEntrypointsSource).toContain("from '@blade-ai/agent-sdk/server'");
    expect(packageEntrypointsSource).not.toContain('../../packages/agent-sdk/src');
    expect(rootTsconfigSource).toContain('"@blade-ai/agent-sdk"');
    expect(rootTsconfigSource).toContain('"@blade-ai/agent-sdk/server"');
    expect(vitestConfigSource).toContain("'@blade-ai/agent-sdk'");
    expect(vitestConfigSource).toContain("'@blade-ai/agent-sdk/server'");
  });

  it('keeps package-local session runtime on explicit agent package subpaths', () => {
    const files = [
      'packages/agent-sdk/src/session/kernelFactory.ts',
      'packages/agent-sdk/src/session/kernelModelResolver.ts',
      'packages/agent-sdk/src/session/kernelStreamBridge.ts',
      'packages/agent-sdk/src/session/kernelStreamProjection.ts',
      'packages/agent-sdk/src/session/kernelTracePort.ts',
      'packages/agent-sdk/src/session/runtimeAgentKernels.ts',
      'packages/agent-sdk/src/session/runtimeHooks.ts',
      'packages/agent-sdk/src/session/runtimeInstance.ts',
      'packages/agent-sdk/src/session/runtimeKernelModels.ts',
      'packages/agent-sdk/src/session/runtimeKernelPorts.ts',
      'packages/agent-sdk/src/session/runtimeKernelTraceFinalization.ts',
      'packages/agent-sdk/src/session/runtimeKernelTurnStream.ts',
      'packages/agent-sdk/src/session/runtimePorts.ts',
      'packages/agent-sdk/src/session/runtimeRunTurn.ts',
      'packages/agent-sdk/src/session/runtimeToolExecution.ts',
      'packages/agent-sdk/src/session/store.ts',
      'packages/agent-sdk/src/session/streamingToolExecutor.ts',
    ];

    for (const file of files) {
      const source = readFileSync(file, 'utf-8');

      expect(source, `${file} should not rely on the agent root barrel`).not.toContain(
        "from '@blade-ai/agent'",
      );
    }
  });

  it('keeps package-local runtime tests on explicit agent package subpaths', () => {
    const files = [
      'packages/agent-sdk/src/__tests__/defaultKernelRuntimeFactory.test.ts',
      'packages/agent-sdk/src/__tests__/runtimeAgentKernels.test.ts',
      'packages/agent-sdk/src/__tests__/runtimeKernel.test.ts',
      'packages/agent-sdk/src/__tests__/runtimeKernelModels.test.ts',
      'packages/agent-sdk/src/__tests__/runtimeKernelTraceFinalization.test.ts',
      'packages/agent-sdk/src/__tests__/runtimeKernelTurnStream.test.ts',
      'packages/agent-sdk/src/__tests__/runtimeTurn.test.ts',
    ];

    for (const file of files) {
      const source = readFileSync(file, 'utf-8');

      expect(source, `${file} should not rely on the agent root barrel`).not.toContain(
        "from '@blade-ai/agent'",
      );
    }
  });

  it('keeps package builds isolated from the root package config', () => {
    for (const dir of ['packages/ai', 'packages/agent', 'packages/agent-sdk']) {
      const pkg = readJson(join(dir, 'package.json'));

      expect(existsSync(join(dir, 'tsup.config.ts')), `${dir}/tsup.config.ts`).toBe(true);
      expect(existsSync(join(dir, 'tsconfig.build.json')), `${dir}/tsconfig.build.json`).toBe(true);
      expect(pkg.scripts?.build).toContain('tsup --config tsup.config.ts');
      expect(pkg.scripts?.build).toContain('tsc -p tsconfig.build.json');
    }
  });

  it('emits agent-sdk build declarations from package-local source only', () => {
    const buildConfig = readJson('packages/agent-sdk/tsconfig.build.json');

    expect(buildConfig.compilerOptions?.rootDir).toBe('./src');
    expect(buildConfig.include).toEqual(['src/**/*']);
    expect(buildConfig.compilerOptions?.paths).toMatchObject({
      '@blade-ai/agent': ['../agent/dist/index.d.ts'],
      '@blade-ai/agent/budget': ['../agent/dist/budget/TokenBudget.d.ts'],
      '@blade-ai/ai': ['../ai/dist/index.d.ts'],
      '@blade-ai/ai/deepseek': ['../ai/dist/deepseek/index.d.ts'],
      '@blade-ai/ai/providers/vercel': ['../ai/dist/providers/vercel/index.d.ts'],
    });
    expect(JSON.stringify(buildConfig.compilerOptions?.paths)).not.toContain('@/*');
    expect(JSON.stringify(buildConfig)).not.toContain('../../src');
  });

  it('overlays package-local public declarations for agent-sdk', () => {
    const sdk = readJson('packages/agent-sdk/package.json');
    const publicDts = readJson('packages/agent-sdk/tsconfig.public-dts.json');
    const overlayScript = readFileSync('packages/agent-sdk/scripts/overlay-public-dts.mjs', 'utf-8');

    expect(existsSync('packages/agent-sdk/tsconfig.public-dts.json')).toBe(true);
    expect(existsSync('packages/agent-sdk/scripts/overlay-public-dts.mjs')).toBe(true);
    expect(sdk.scripts?.build).toContain('tsc -p tsconfig.public-dts.json');
    expect(sdk.scripts?.build).toContain('node scripts/overlay-public-dts.mjs');
    expect(publicDts.files).toContain('src/core/index.ts');
    expect(publicDts.files).toContain('src/types/permissions.ts');
    expect(publicDts.files).toContain('src/session/store.ts');
    expect(overlayScript).toContain('local/public-index.d.ts');
    expect(overlayScript).toContain('public-index.js');
    expect(overlayScript).toContain('types/permissions.d.ts.map');
  });

  it('emits agent-sdk public declarations from built package declarations', () => {
    const publicDts = readJson('packages/agent-sdk/tsconfig.public-dts.json');

    expect(publicDts.compilerOptions?.paths).toMatchObject({
      '@blade-ai/agent': ['../agent/dist/index.d.ts'],
      '@blade-ai/agent/budget': ['../agent/dist/budget/TokenBudget.d.ts'],
      '@blade-ai/ai': ['../ai/dist/index.d.ts'],
      '@blade-ai/ai/deepseek': ['../ai/dist/deepseek/index.d.ts'],
    });
    expect(JSON.stringify(publicDts.compilerOptions?.paths)).not.toContain('../../src');
    expect(JSON.stringify(publicDts.compilerOptions?.paths)).not.toContain('../ai/src');
    expect(JSON.stringify(publicDts.compilerOptions?.paths)).not.toContain('../agent/src');
  });

  it('builds the publishable agent-sdk package from its own package manifest', () => {
    const config = readFileSync('packages/agent-sdk/tsup.config.ts', 'utf-8');

    expect(config).toContain("readFileSync('./package.json'");
    expect(config).not.toContain("readFileSync('../../package.json'");
  });

  it('builds the publishable agent-sdk package from package-local source entries', () => {
    const config = readFileSync('packages/agent-sdk/tsup.config.ts', 'utf-8');

    for (const entry of [
      'index',
      'browser/index',
      'browser/server-only-stub',
      'core/index',
      'local/index',
      'server/index',
      'session/index',
      'tools/index',
    ]) {
      const expectedEntry = entry.includes('/')
        ? `'${entry}': 'src/${entry}.ts'`
        : `${entry}: 'src/${entry}.ts'`;
      expect(config, `${entry} should be built from packages/agent-sdk/src`).toContain(
        expectedEntry,
      );
      expect(existsSync(join('packages/agent-sdk/src', `${entry}.ts`)), `${entry}.ts`).toBe(true);
    }

    expect(config).not.toContain('../../src/');
  });

  it('owns browser-safe agent-sdk public entry source inside the package', () => {
    for (const file of [
      'packages/agent-sdk/src/browser/index.ts',
      'packages/agent-sdk/src/browser/server-only-stub.ts',
      'packages/agent-sdk/src/core/index.ts',
    ]) {
      const source = readFileSync(file, 'utf-8');

      expect(source, `${file} should not be a root source wildcard forwarder`).not.toMatch(
        /export \* from ['"]\.\.\/\.\.\/\.\.\/\.\.\/src\//,
      );
    }
  });

  it('owns core json, constant, and permission contracts inside agent-sdk', () => {
    for (const file of [
      'packages/agent-sdk/src/types/common.ts',
      'packages/agent-sdk/src/types/constants.ts',
      'packages/agent-sdk/src/types/permissions.ts',
    ]) {
      expect(existsSync(file), file).toBe(true);
    }

    const coreSource = readFileSync('packages/agent-sdk/src/core/index.ts', 'utf-8');

    expect(coreSource).not.toContain('../../../../src/types/common.js');
    expect(coreSource).not.toContain('../../../../src/types/constants.js');
    expect(coreSource).not.toContain('../../../../src/types/permissions.js');
  });

  it('owns core tool kind and behavior contracts inside agent-sdk', () => {
    expect(existsSync('packages/agent-sdk/src/tools/types/ToolKind.ts')).toBe(true);

    const coreSource = readFileSync('packages/agent-sdk/src/core/index.ts', 'utf-8');
    const permissionsSource = readFileSync('packages/agent-sdk/src/types/permissions.ts', 'utf-8');

    expect(coreSource).not.toContain('../../../../src/tools/types/ToolKind.js');
    expect(permissionsSource).not.toContain('../../../../src/tools/types/ToolKind.js');
  });

  it('owns core tool contracts inside agent-sdk', () => {
    expect(existsSync('packages/agent-sdk/src/tools/types/index.ts')).toBe(true);

    const coreSource = readFileSync('packages/agent-sdk/src/core/index.ts', 'utf-8');
    const permissionsSource = readFileSync('packages/agent-sdk/src/types/permissions.ts', 'utf-8');

    expect(coreSource).not.toContain('../../../../src/tools/types/index.js');
    expect(permissionsSource).not.toContain('../../../../src/tools/types/index.js');
  });

  it('owns the public tools entry source inside agent-sdk', () => {
    const toolsSource = readFileSync('packages/agent-sdk/src/tools/index.ts', 'utf-8');

    expect(toolsSource).not.toContain("export * from '../../../../src/tools/index.js'");
    expect(toolsSource).not.toContain("../../../../src/tools/catalog/ToolCatalog.js");
    expect(toolsSource).not.toContain("../../../../src/tools/core/createTool.js");
    expect(toolsSource).toContain("from './types/index.js'");
    expect(toolsSource).toContain("from './types/ToolKind.js'");
    expect(existsSync('packages/agent-sdk/src/tools/public-index.ts')).toBe(true);
  });

  it('owns node adapter public entry sources inside agent-sdk', () => {
    const serverSource = readFileSync('packages/agent-sdk/src/server/index.ts', 'utf-8');
    const localSource = readFileSync('packages/agent-sdk/src/local/index.ts', 'utf-8');
    const localMemorySource = readFileSync('packages/agent-sdk/src/local/memory.ts', 'utf-8');
    const localMcpSource = readFileSync('packages/agent-sdk/src/local/mcp.ts', 'utf-8');
    const localBuiltinToolsSource = readFileSync(
      'packages/agent-sdk/src/local/builtin-tools.ts',
      'utf-8',
    );
    const localSandboxSource = readFileSync('packages/agent-sdk/src/local/sandbox.ts', 'utf-8');

    expect(serverSource).not.toContain("export * from '../../../../src/server/index.js'");
    expect(serverSource).not.toContain("from '../index.js'");
    expect(serverSource).toContain("from '../session/index.js'");
    expect(serverSource).toContain("from '../core/index.js'");
    expect(serverSource).toContain("from '../tools/index.js'");
    expect(serverSource).toContain("from '../subagents/index.js'");
    expect(localSource).not.toContain("export * from '../../../../src/local/index.js'");
    expect(localSource).not.toContain("../../../../src/");
    expect(localMcpSource).not.toContain('../../../../src/mcp');
    expect(localMemorySource).not.toContain("../../../../src/memory");
    expect(localBuiltinToolsSource).not.toContain('../../../../src/tools/builtin');
    expect(localBuiltinToolsSource).not.toContain('../../../../src/tools/builtin/memory');
    expect(localSandboxSource).not.toContain('../../../../src/sandbox');
    for (const file of [
      'packages/agent-sdk/src/local/mcp.ts',
      'packages/agent-sdk/src/local/memory.ts',
      'packages/agent-sdk/src/local/memoryRead.ts',
      'packages/agent-sdk/src/local/memoryWrite.ts',
      'packages/agent-sdk/src/local/sandbox.ts',
      'packages/agent-sdk/src/local/builtin-tools.ts',
    ]) {
      expect(existsSync(file), file).toBe(true);
    }
    expect(localSource).toContain('createSdkMcpServer');
    expect(localSource).toContain('getBuiltinTools');
    expect(localSource).toContain('SandboxService');
  });

  it('owns the session-first root public entry source inside agent-sdk', () => {
    const rootSource = readFileSync('packages/agent-sdk/src/index.ts', 'utf-8');

    expect(rootSource).not.toContain("export * from '../../../src/index.js'");
    expect(rootSource).not.toContain("../../../src/agent/subagents");
    expect(rootSource).toContain("from './session/index.js'");
    expect(rootSource).toContain("from './tools/index.js'");
    expect(rootSource).toContain("from './core/index.js'");
  });

  it('owns root subagent compatibility exports inside agent-sdk', () => {
    const rootSource = readFileSync('packages/agent-sdk/src/index.ts', 'utf-8');

    for (const file of [
      'packages/agent-sdk/src/subagents/index.ts',
      'packages/agent-sdk/src/subagents/SubagentExecutor.ts',
      'packages/agent-sdk/src/subagents/SubagentRegistry.ts',
      'packages/agent-sdk/src/subagents/types.ts',
    ]) {
      expect(existsSync(file), file).toBe(true);
    }

    expect(rootSource).toContain("from './subagents/index.js'");
  });

  it('owns permission handler runtime factories inside agent-sdk', () => {
    const rootSource = readFileSync('packages/agent-sdk/src/index.ts', 'utf-8');
    const permissionsSource = readFileSync('packages/agent-sdk/src/types/permissions.ts', 'utf-8');

    expect(rootSource).not.toContain("from '../../../src/types/permissions.js'");
    expect(permissionsSource).toContain('createPermissionHandlerFromCanUseTool');
    expect(permissionsSource).toContain('createModePermissionHandler');
    expect(permissionsSource).toContain('createRuleBasedPermissionHandler');
    expect(permissionsSource).toContain('createPathSafetyPermissionHandler');
    expect(permissionsSource).toContain('createCompositePermissionHandler');
  });

  it('organizes the agent package around kernel, budget, loop, protocol, ports, recovery, state, and tracing modules', () => {
    for (const file of [
      'packages/agent/src/kernel/AgentKernel.ts',
      'packages/agent/src/budget/TokenBudget.ts',
      'packages/agent/src/epoch/ExecutionEpoch.ts',
      'packages/agent/src/loop/index.ts',
      'packages/agent/src/loop/AsyncEventQueue.ts',
      'packages/agent/src/loop/agentLoop.ts',
      'packages/agent/src/loop/assistantMessage.ts',
      'packages/agent/src/loop/decideNoToolTurn.ts',
      'packages/agent/src/loop/decideTurnLimit.ts',
      'packages/agent/src/loop/planToolExecution.ts',
      'packages/agent/src/loop/repairToolCallParams.ts',
      'packages/agent/src/loop/loopEvents.ts',
      'packages/agent/src/loop/responseEvents.ts',
      'packages/agent/src/loop/loopClock.ts',
      'packages/agent/src/loop/loopResult.ts',
      'packages/agent/src/loop/tokenUsage.ts',
      'packages/agent/src/loop/tokenUsageTracker.ts',
      'packages/agent/src/loop/toolMessage.ts',
      'packages/agent/src/loop/toolResultContinuation.ts',
      'packages/agent/src/loop/toolResultContent.ts',
      'packages/agent/src/loop/toolResultTracker.ts',
      'packages/agent/src/loop/toolStartEvent.ts',
      'packages/agent/src/loop/turnCycle.ts',
      'packages/agent/src/loop/turnState.ts',
      'packages/agent/src/loop/turnCounter.ts',
      'packages/agent/src/loop/turnStream.ts',
      'packages/agent/src/loop/toolBehavior.ts',
      'packages/agent/src/loop/toolInterruptBehavior.ts',
      'packages/agent/src/loop/toolUpdateToAgentEvent.ts',
      'src/agent/loop/adapterContracts.ts',
      'src/agent/loop/rootAgentLoopAdapter.ts',
      'packages/agent/src/protocol/index.ts',
      'packages/agent/src/ports/index.ts',
      'packages/agent/src/recovery/index.ts',
      'packages/agent/src/recovery/isOverflowRecoverable.ts',
      'packages/agent/src/recovery/recoveryAttemptTracker.ts',
      'packages/agent/src/recovery/recoveryEvents.ts',
      'packages/agent/src/state/index.ts',
      'packages/agent/src/state/systemSource.ts',
      'packages/agent/src/state/toolInjectedMessages.ts',
      'packages/agent/src/tracing/index.ts',
    ]) {
      expect(existsSync(file), file).toBe(true);
    }

    expect(existsSync('packages/agent/src/__tests__/toolUpdateToAgentEvent.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/agentLoop.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/assistantMessage.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/AsyncEventQueueBehavior.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/loopDecisionsBehavior.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/planToolExecutionBehavior.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/loopEvents.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/responseEvents.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/loopClock.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/loopResult.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/tokenUsageProjection.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/tokenUsageTracker.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/toolMessage.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/toolResultContinuation.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/toolResultContent.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/toolResultTracker.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/toolStartEvent.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/turnCycle.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/turnStateProjection.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/turnCounter.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/turnStream.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/toolInjectedMessages.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/recoveryAttemptTracker.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/recoveryEvents.test.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/repairToolCallParamsBehavior.test.ts')).toBe(
      true,
    );

    const agentIndexSource = readFileSync('packages/agent/src/index.ts', 'utf-8');
    const agentLoopSource = readFileSync('packages/agent/src/loop/index.ts', 'utf-8');
    const rootAgentLoopSource = readFileSync('src/agent/AgentLoop.ts', 'utf-8');
    const rootAdapterContractsSource = readFileSync('src/agent/loop/adapterContracts.ts', 'utf-8');
    const rootAgentLoopAdapterSource = readFileSync(
      'src/agent/loop/rootAgentLoopAdapter.ts',
      'utf-8',
    );
    const agentRecoverySource = readFileSync('packages/agent/src/recovery/index.ts', 'utf-8');
    const agentStateSource = readFileSync('packages/agent/src/state/index.ts', 'utf-8');

    expect(agentIndexSource).not.toContain('class AgentKernel');
    expect(agentLoopSource).toContain("from './AsyncEventQueue.js'");
    expect(agentLoopSource).toContain("from './agentLoop.js'");
    expect(readFileSync('packages/agent/src/loop/agentLoop.ts', 'utf-8')).toContain(
      'export interface AgentLoopAdapterHooks',
    );
    expect(readFileSync('packages/agent/src/loop/agentLoop.ts', 'utf-8')).toContain(
      'export interface AgentLoopAdapterConfig',
    );
    expect(agentLoopSource).toContain("from './assistantMessage.js'");
    expect(agentLoopSource).toContain("from './decideNoToolTurn.js'");
    expect(agentLoopSource).toContain("from './decideTurnLimit.js'");
    expect(agentLoopSource).toContain("from './planToolExecution.js'");
    expect(agentLoopSource).toContain("from './repairToolCallParams.js'");
    expect(agentLoopSource).toContain("from './loopEvents.js'");
    expect(agentLoopSource).toContain("from './modelResponseTurn.js'");
    expect(agentLoopSource).toContain("from './responseEvents.js'");
    expect(agentLoopSource).toContain("from './loopClock.js'");
    expect(agentLoopSource).toContain("from './loopResult.js'");
    expect(agentLoopSource).toContain("from './tokenUsage.js'");
    expect(agentLoopSource).toContain("from './tokenUsageTracker.js'");
    expect(agentLoopSource).toContain("from './toolMessage.js'");
    expect(agentLoopSource).toContain("from './toolInjectedMessages.js'");
    expect(agentLoopSource).toContain("from './toolResultContinuation.js'");
    expect(agentLoopSource).toContain("from './toolResultContent.js'");
    expect(agentLoopSource).toContain("from './toolResponseTurn.js'");
    expect(agentLoopSource).toContain("from './toolResultTracker.js'");
    expect(agentLoopSource).toContain("from './toolStartEvent.js'");
    expect(agentLoopSource).toContain("from './turnCycle.js'");
    expect(agentLoopSource).toContain("from './turnState.js'");
    expect(agentLoopSource).toContain("from './turnCounter.js'");
    expect(agentLoopSource).toContain("from './turnEntry.js'");
    expect(agentLoopSource).toContain("from './toolInterruptBehavior.js'");
    expect(agentLoopSource).toContain("from './toolUpdateToAgentEvent.js'");
    expect(rootAgentLoopSource).toContain("from './loop/rootAgentLoopAdapter.js'");
    expect(rootAgentLoopSource).not.toContain('handleAgentLoopWithEmissions');
    expect(rootAgentLoopAdapterSource).toContain('handleAgentLoopWithEmissions');
    expect(rootAgentLoopSource).toContain("from './loop/adapterContracts.js'");
    expect(rootAdapterContractsSource).toContain('AgentLoopAdapterConfig');
    expect(rootAdapterContractsSource).toContain('AgentLoopAdapterHooks');
    expect(rootAgentLoopSource).not.toContain('NOOP_LOGGER');
    expect(rootAgentLoopSource).not.toContain('ExecutionEpoch');
    expect(rootAgentLoopSource).not.toContain('executeToolCalls');
    expect(rootAgentLoopSource).not.toContain('runTurn');
    expect(rootAgentLoopSource).not.toContain('export interface AgentLoopHooks');
    expect(rootAgentLoopSource).not.toContain('export interface AgentLoopConfig');
    expect(rootAgentLoopSource).not.toContain('handleAgentLoopTurnCycleWithEmissions');
    expect(rootAgentLoopSource).not.toContain('handleAgentLoopTurnEntryWithEmissions');
    expect(rootAgentLoopSource).not.toContain('handleAgentLoopRunTurnWithRecovery');
    expect(rootAgentLoopSource).not.toContain('handleAgentLoopModelResponseWithEmissions');
    expect(rootAgentLoopSource).not.toContain('handleAgentLoopToolResponseWithEmissions');
    expect(rootAgentLoopSource).not.toContain('const turnEntry');
    expect(rootAgentLoopSource).not.toContain('const runTurnHandling');
    expect(rootAgentLoopSource).not.toContain('const modelResponseHandling');
    expect(rootAgentLoopSource).not.toContain('const toolResponseHandling');
    expect(rootAgentLoopSource).not.toContain('handleAgentLoopAbortIfRequested');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopAbortCompletion');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopAbortCompletionInputFromLoopState');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopAbortCompletionInputFromCounterState');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopAbortCompletionInputFromTiming');
    expect(rootAgentLoopSource).not.toMatch(
      /buildAgentLoopAbortCompletion\(\{\s+\.\.\.loopClock\.resultTiming/,
    );
    expect(rootAgentLoopSource).not.toMatch(
      /buildAgentLoopAbortCompletionInput\(\{\s+\.\.\.loopClock\.resultTiming/,
    );
    expect(rootAgentLoopSource).not.toMatch(
      /buildAgentLoopAbortCompletionInputFromLoopState\(\{\s+timing: loopClock\.resultTiming/,
    );
    expect(rootAgentLoopSource).not.toContain('shouldAbortAgentLoop');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopStartEvent');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopTurnStartEvent');
    expect(rootAgentLoopSource).not.toContain('handleAgentLoopToolResponseWithEmissions');
    expect(rootAgentLoopSource).not.toContain('handleAgentLoopToolTurnTail');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopToolTurnCompletion');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopToolTurnCompletionInput');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopToolTurnCompletion({');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopReactiveCompactRetryEvent');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopTurnRetryEvent');
    expect(rootAgentLoopSource).not.toContain('handleAgentLoopModelResponseWithEmissions');
    expect(rootAgentLoopSource).not.toContain('handleAgentLoopResponseNoToolGateWithEmissions');
    expect(rootAgentLoopSource).not.toContain('handleAgentLoopNoToolTurnWithEmissions');
    expect(rootAgentLoopSource).not.toContain('handleAgentLoopNoToolTurn({');
    expect(rootAgentLoopSource).not.toContain('noToolHandling.continuation.events');
    expect(rootAgentLoopSource).not.toContain('noToolHandling.successDecision.events');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopNoToolContent');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopNoToolContinuation');
    expect(rootAgentLoopSource).not.toContain('runAgentLoopNoToolCompleteHook');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopNoToolCompletePayload');
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentLoopNoToolDecisionInputFromHookContainer',
    );
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentLoopNoToolDecisionInputFromConversation',
    );
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopNoToolStopHooksInput');
    expect(rootAgentLoopSource).not.toContain('const stopCheck = stopHooks?.check');
    expect(rootAgentLoopSource).not.toContain('onStopCheck: stopHooks?.check');
    expect(rootAgentLoopSource).not.toContain('const stopHooks = hooks?.stop');
    expect(rootAgentLoopSource).not.toContain('check: stopHooks?.check');
    expect(rootAgentLoopSource).not.toMatch(
      /buildAgentLoopNoToolDecisionInput\(\{\s+content,\s+messages: convState\.toArray\(\)/,
    );
    expect(rootAgentLoopSource).not.toContain('decideAgentLoopNoToolTurn');
    expect(rootAgentLoopSource).not.toContain('shouldHandleAgentLoopNoToolTurn');
    expect(rootAgentLoopSource).not.toContain('shouldContinueAgentLoopAfterNoToolDecision');
    expect(rootAgentLoopSource).not.toContain('emitAgentLoopResponseEventsFromTurnResult');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopResponseEventsInput');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopResponseEvents');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopNoToolSuccessDecision');
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentLoopNoToolSuccessDecisionInputFromLoopState',
    );
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentLoopNoToolSuccessDecisionInputFromTiming',
    );
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopNoToolSuccessDecision({');
    expect(rootAgentLoopSource).not.toMatch(
      /buildAgentLoopNoToolSuccessDecisionInput\(\{\s+finalMessage:[\s\S]*\.\.\.loopClock\.resultTiming/,
    );
    expect(rootAgentLoopSource).not.toContain('loopClock.resultTiming');
    expect(rootAgentLoopSource).not.toContain(
      'toolCallsCount: toolResultTracker.toolCallsCount',
    );
    expect(rootAgentLoopSource).not.toContain('tokenUsageTracker.totalTokens');
    expect(rootAgentLoopSource).not.toContain('tokenBudget?.getSnapshot()');
    expect(rootAgentLoopSource).not.toContain(
      'handleAgentLoopToolExecutionResultsWithEmissions',
    );
    expect(rootAgentLoopSource).not.toContain('handleAgentLoopToolResults');
    expect(rootAgentLoopSource).not.toContain('handleAgentLoopToolResult({');
    expect(rootAgentLoopSource).not.toContain(
      'shouldStopAgentLoopToolResultProcessing',
    );
    expect(rootAgentLoopSource).not.toContain(
      'for (const { toolCall, result, toolUseUuid } of executionResults)',
    );
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopToolExitDecisionInputFromLoopState');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopToolExitDecisionInputFromTiming');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopToolExitDecision');
    expect(rootAgentLoopSource).not.toMatch(
      /buildAgentLoopToolExitDecisionInput\(\{\s+toolCall,\s+result,\s+streamingExecutionResults,[\s\S]*\.\.\.loopClock\.resultTiming/,
    );
    expect(rootAgentLoopSource).not.toContain('shouldExitAgentLoopForToolDecision');
    expect(rootAgentLoopSource).not.toContain('const toolExecutionResults');
    expect(rootAgentLoopSource).not.toContain("toolExecutionResults.action === 'exit'");
    expect(rootAgentLoopSource).not.toContain('const toolTurnTail');
    expect(rootAgentLoopSource).not.toContain("toolTurnTail.action === 'stop'");
    expect(rootAgentLoopSource).not.toContain('createAgentLoopClock');
    expect(rootAgentLoopSource).not.toContain('handleAgentLoopAssistantMessage');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopAssistantMessageProjection');
    expect(rootAgentLoopSource).not.toContain('runAgentLoopAssistantMessageHook');
    expect(rootAgentLoopSource).not.toContain('messageHooks?.onAssistant');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopToolResultContinuation');
    expect(rootAgentLoopSource).not.toContain('runAgentLoopToolResultAfterExecHook');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopAfterExecHookPayload');
    expect(rootAgentLoopSource).not.toContain('toolHooks?.afterExec');
    expect(rootAgentLoopSource).not.toContain(
      'toolResultContinuation.shouldRunAfterExecHook',
    );
    expect(rootAgentLoopSource).not.toContain('applyAgentLoopToolResultContinuation');
    expect(rootAgentLoopSource).not.toContain(
      'convState.append(...buildAgentLoopToolResultAppendMessages(toolResultContinuation))',
    );
    expect(rootAgentLoopSource).not.toContain('handleAgentLoopPostUsageGateWithEmissions');
    expect(rootAgentLoopSource).not.toContain('emitAgentLoopTokenUsageEventIfPresent');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopTokenUsageInfo');
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentLoopTokenUsageInfoInputFromLoopState',
    );
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentLoopTokenUsageInfoInputFromTurnProjection',
    );
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopTokenUsageInfo({');
    expect(rootAgentLoopSource).not.toMatch(
      /buildAgentLoopTokenUsageInfoInput\(\{\s+modelUsage: turnResult\.usage/,
    );
    expect(rootAgentLoopSource).not.toContain(
      'maxContextTokens: turnStateProjection.maxContextTokens',
    );
    expect(rootAgentLoopSource).not.toContain('tokenUsageTracker.totalTokens');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopTokenUsageEvent');
    expect(rootAgentLoopSource).not.toContain('yield buildAgentLoopTokenUsageEvent');
    expect(rootAgentLoopSource).not.toContain('handleAgentLoopTokenBudgetCheck');
    expect(rootAgentLoopSource).not.toContain('const budgetCheck');
    expect(rootAgentLoopSource).not.toContain("budgetCheck.action === 'stop'");
    expect(rootAgentLoopSource).not.toContain('const postUsageGate');
    expect(rootAgentLoopSource).not.toContain("postUsageGate.action === 'stop'");
    expect(rootAgentLoopSource).not.toContain('const responseNoToolGate');
    expect(rootAgentLoopSource).not.toContain("responseNoToolGate.action === 'finish'");
    expect(rootAgentLoopSource).not.toContain('const abortAfterBudget');
    expect(rootAgentLoopSource).not.toContain("abortAfterBudget.action === 'abort'");
    expect(rootAgentLoopSource).not.toContain('runAgentLoopTokenBudgetCheck');
    expect(rootAgentLoopSource).not.toContain('shouldStopAgentLoopForTokenBudgetCheck');
    expect(rootAgentLoopSource).not.toContain('applyAgentLoopTokenBudget');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopTokenBudgetInputFromLoopState');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopTokenBudgetInputFromTiming');
    expect(rootAgentLoopSource).not.toContain('applyAgentLoopTokenBudget({');
    expect(rootAgentLoopSource).not.toMatch(
      /buildAgentLoopTokenBudgetInput\(\{\s+tokenBudget,\s+modelUsage:[\s\S]*\.\.\.loopClock\.resultTiming/,
    );
    expect(rootAgentLoopSource).not.toContain('loopClock.resultTiming');
    expect(rootAgentLoopSource).not.toContain(
      'toolCallsCount: toolResultTracker.toolCallsCount',
    );
    expect(rootAgentLoopSource).not.toContain('tokenUsageTracker.totalTokens');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopTokenBudgetStopCompletion');
    expect(rootAgentLoopSource).not.toContain('shouldStopAgentLoopForTokenBudget(');
    expect(rootAgentLoopSource).not.toContain('createAgentLoopTokenUsageTracker');
    expect(rootAgentLoopSource).not.toContain('recordAgentLoopTokenUsage');
    expect(rootAgentLoopSource).not.toContain('tokenUsageTracker.record(');
    expect(rootAgentLoopSource).not.toContain('shouldRecordAgentLoopTokenUsage');
    expect(rootAgentLoopSource).not.toContain('createAgentToolResultTracker');
    expect(rootAgentLoopSource).not.toContain('recordAgentToolResult');
    expect(rootAgentLoopSource).not.toContain('toolResultTracker.record(');
    expect(rootAgentLoopSource).not.toContain(
      'handleAgentLoopNonStreamingToolExecutionWithEmissions',
    );
    expect(rootAgentLoopSource).not.toContain(
      'handleAgentLoopNonStreamingToolExecutionGateWithEmissions',
    );
    expect(rootAgentLoopSource).not.toContain('prepareAgentLoopNonStreamingToolExecution');
    expect(rootAgentLoopSource).not.toContain('shouldRunAgentLoopNonStreamingToolExecution');
    expect(rootAgentLoopSource).not.toContain('abortBeforeToolExecution');
    expect(rootAgentLoopSource).not.toContain('executeInput');
    expect(rootAgentLoopSource).not.toContain('let executionResults');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopToolStartEvents');
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentLoopToolStartEventsInputFromExecutionPipeline',
    );
    expect(rootAgentLoopSource).not.toMatch(
      /buildAgentLoopToolStartEventsInput\(\{\s+plan: executionPlan/,
    );
    expect(rootAgentLoopSource).not.toContain('registry: executionPipeline.getRegistry()');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopTurnStateProjection');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopEffectiveMaxTurns');
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentLoopTurnLimitDecisionInputFromHookContainer',
    );
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopTurnLimitHooksInput');
    expect(rootAgentLoopSource).not.toContain('onTurnLimitReached: turnHooks?.onTurnLimitReached');
    expect(rootAgentLoopSource).not.toContain('const turnHooks = hooks?.turn');
    expect(rootAgentLoopSource).not.toContain('hooks: turnHooks');
    expect(rootAgentLoopSource).not.toMatch(
      /buildAgentLoopTurnLimitDecisionInput\(\{\s+maxTurns: config\.maxTurns,\s+turnsCount,\s+contextMessages: convState\.getContextMessages\(\)/,
    );
    expect(rootAgentLoopSource).not.toContain(
      'contextMessages: convState.getContextMessages()',
    );
    expect(rootAgentLoopSource).not.toContain(
      'toolCallsCount: toolResultTracker.toolCallsCount',
    );
    expect(rootAgentLoopSource).not.toContain('startTime: loopClock.startTime');
    expect(rootAgentLoopSource).not.toContain(
      'totalTokens: tokenUsageTracker.totalTokens',
    );
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopTurnLimitContinuation');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopTurnLimitStopCompletion');
    expect(rootAgentLoopSource).not.toContain('shouldApplyAgentLoopTurnLimitContinuation');
    expect(rootAgentLoopSource).not.toContain('applyAgentLoopTurnLimitContinuation');
    expect(rootAgentLoopSource).not.toContain(
      'convState.replaceContent(turnLimitContinuation.compactedMessages)',
    );
    expect(rootAgentLoopSource).not.toContain(
      'convState.append(...turnLimitContinuation.appendMessages)',
    );
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentLoopExecuteToolCallsInputFromTurnProjection',
    );
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopExecuteToolCallsHooksInput');
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentLoopExecuteToolCallsHooksInputFromHookContainer',
    );
    expect(rootAgentLoopSource).not.toContain('onBeforeToolExec: toolHooks?.beforeExec');
    expect(rootAgentLoopSource).not.toMatch(
      /buildAgentLoopExecuteToolCallsInput\(\{\s+plan: executionPlan/,
    );
    expect(rootAgentLoopSource).not.toContain(
      'executionContext: turnStateProjection.executionContext',
    );
    expect(rootAgentLoopSource).not.toContain(
      'permissionMode: turnStateProjection.permissionMode',
    );
    expect(rootAgentLoopSource).not.toContain('hookContainer: hooks');
    expect(rootAgentLoopSource).not.toContain('hooks: {');
    expect(rootAgentLoopSource).not.toContain('beforeExec: toolHooks?.beforeExec');
    expect(rootAgentLoopSource).not.toContain('onUpdate: toolHooks?.onUpdate');
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentLoopToolExecutionPlanInputFromExecutionPipelineProjection',
    );
    expect(rootAgentLoopSource).not.toContain('planAgentLoopToolExecution');
    expect(rootAgentLoopSource).not.toContain('selectAgentFunctionToolCalls');
    expect(rootAgentLoopSource).not.toMatch(
      /buildAgentLoopToolExecutionPlanInput\(\{\s+calls: functionCalls/,
    );
    expect(rootAgentLoopSource).not.toContain('registry: executionPipeline.getRegistry()');
    expect(rootAgentLoopSource).not.toContain('shouldStopAgentLoopForTurnLimitDecision');
    expect(rootAgentLoopSource).not.toContain('createAgentLoopTurnCounter');
    expect(rootAgentLoopSource).not.toContain('handleAgentLoopTurnStart');
    expect(rootAgentLoopSource).not.toContain('beginAgentLoopTurn');
    expect(rootAgentLoopSource).not.toContain('turnCounter.beginTurn(');
    expect(rootAgentLoopSource).not.toContain('applyAgentLoopReactiveCompactRetry');
    expect(rootAgentLoopSource).not.toContain('requestAgentLoopTurnRetry');
    expect(rootAgentLoopSource).not.toContain('turnCounter.requestRetry(');
    expect(rootAgentLoopSource).not.toContain('resetAgentLoopTurnCounter');
    expect(rootAgentLoopSource).not.toContain('turnCounter.reset(');
    expect(rootAgentLoopSource).not.toContain('shouldEmitAgentLoopTurnStart');
    expect(rootAgentLoopSource).not.toContain('runAgentLoopBeforeTurnHook');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopBeforeTurnHookPayloadFromLoopState');
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentLoopBeforeTurnHookPayloadFromConversation',
    );
    expect(rootAgentLoopSource).not.toContain('tokenUsageTracker.lastPromptTokens');
    expect(rootAgentLoopSource).not.toMatch(
      /buildAgentLoopBeforeTurnHookPayload\(\{\s+turn: turnCounter\.turnsCount,\s+messages: convState\.toArray\(\)/,
    );
    expect(rootAgentLoopSource).not.toContain('shouldRunAgentLoopBeforeTurnHook');
    expect(rootAgentLoopSource).not.toContain('consumeAgentLoopBeforeTurnStream');
    expect(rootAgentLoopSource).not.toContain('handleAgentLoopRunTurnWithRecovery');
    expect(rootAgentLoopSource).not.toContain('handleAgentRunTurnErrorWithEmissions');
    expect(rootAgentLoopSource).not.toContain(
      'emitAgentRecoveryExhaustedEffectsIfAttempted',
    );
    expect(rootAgentLoopSource).not.toContain(
      'emitAgentRecoveryExhaustedEffectsFromTracker',
    );
    expect(rootAgentLoopSource).not.toContain('hasAgentRecoveryAttemptExhausted');
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentRecoveryExhaustedEffectsFromTracker',
    );
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentRecoveryExhaustedProjectionInputFromTracker',
    );
    expect(rootAgentLoopSource).not.toContain('recoveryAttemptTracker.attempt');
    expect(rootAgentLoopSource).not.toContain(
      'runAgentRecoveryCompactAttemptWithEmissions',
    );
    expect(rootAgentLoopSource).not.toContain(
      'startAgentRecoveryAttemptWithEmittedCompactStream',
    );
    expect(rootAgentLoopSource).not.toContain('startAgentRecoveryAttemptWithCompactStream');
    expect(rootAgentLoopSource).not.toContain('startAgentRecoveryAttemptWithStartedEffects');
    expect(rootAgentLoopSource).not.toContain('startAgentRecoveryAttempt({');
    expect(rootAgentLoopSource).not.toContain('recoveryAttemptTracker.startAttempt(');
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentLoopAbortCompletionInputFromCounterState',
    );
    expect(rootAgentLoopSource).not.toContain('turnCounter.previousCompletedTurnCount');
    expect(rootAgentLoopSource).not.toContain('turnCounter.turnsCount');
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentLoopTurnStateProjectionFromPreparation',
    );
    expect(rootAgentLoopSource).not.toContain('config.prepareTurnState(');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopTurnStateProjection({');
    expect(rootAgentLoopSource).not.toContain('applyAgentLoopNoToolContinuation');
    expect(rootAgentLoopSource).not.toContain('convState.append(noToolContinuation.message)');
    expect(rootAgentLoopSource).not.toContain('applyAgentLoopAssistantMessageProjection');
    expect(rootAgentLoopSource).not.toContain(
      'convState.append(assistantMessageProjection.message)',
    );
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopRunTurnInputFromLoopState');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopRunTurnToolHooksInput');
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentLoopRunTurnToolHooksInputFromHookContainer',
    );
    expect(rootAgentLoopSource).not.toContain('onBeforeExec: toolHooks?.beforeExec');
    expect(rootAgentLoopSource).not.toMatch(
      /buildAgentLoopRunTurnInput\(\{\s+turnState: turnStateProjection\.turnState/,
    );
    expect(rootAgentLoopSource).not.toContain('messages: convState.toArray()');
    expect(rootAgentLoopSource).not.toContain(
      'executionContext: turnStateProjection.executionContext',
    );
    expect(rootAgentLoopSource).not.toContain(
      'permissionMode: turnStateProjection.permissionMode',
    );
    expect(rootAgentLoopSource).not.toContain('consumeAgentLoopTurnStream');
    expect(rootAgentLoopSource).not.toContain('createAgentRecoveryAttemptTracker');
    expect(rootAgentLoopSource).not.toContain('handleAgentRunTurnErrorWithEmissions');
    expect(rootAgentLoopSource).not.toContain('handleAgentModelFallbackWithEmissions');
    expect(rootAgentLoopSource).not.toContain('buildAgentModelFallbackEvent');
    expect(rootAgentLoopSource).not.toContain('llmError instanceof FallbackTriggeredError');
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentRecoveryCompactStreamFromHookContainer',
    );
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentReactiveCompactHookPayloadFromConversation',
    );
    expect(rootAgentLoopSource).not.toMatch(
      /buildAgentReactiveCompactHookPayload\(\{\s+messages: convState\.toArray\(\)/,
    );
    expect(rootAgentLoopSource).not.toContain('handleAgentRunTurnSuccessWithEmissions');
    expect(rootAgentLoopSource).not.toContain('emitAgentRecoveryResetEffects');
    expect(rootAgentLoopSource).not.toContain('consumeAgentRecoveryResetEffects');
    expect(rootAgentLoopSource).not.toContain('buildAgentRecoveryResetEffects');
    expect(rootAgentLoopSource).not.toContain('buildAgentRecoveryStartedEffects');
    expect(rootAgentLoopSource).not.toContain(
      'runAgentRecoveryCompactAttemptWithEmissions',
    );
    expect(rootAgentLoopSource).not.toContain(
      'startAgentRecoveryAttemptWithEmittedCompactStream',
    );
    expect(rootAgentLoopSource).not.toContain('startAgentRecoveryAttemptWithCompactStream');
    expect(rootAgentLoopSource).not.toContain(
      'consumeAgentRecoveryCompactStreamWithEmittedResultEffects',
    );
    expect(rootAgentLoopSource).not.toContain(
      'consumeAgentRecoveryCompactStreamWithResultEffects',
    );
    expect(rootAgentLoopSource).not.toContain('buildAgentRecoveryCompactResultEffects');
    expect(rootAgentLoopSource).not.toContain('buildAgentRecoveryCompactFailedEffects');
    expect(rootAgentLoopSource).not.toContain('buildAgentRecoveryRetryingEffects');
    expect(rootAgentLoopSource).not.toContain(
      'emitAgentRecoveryExhaustedEffectsIfAttempted',
    );
    expect(rootAgentLoopSource).not.toContain(
      'emitAgentRecoveryExhaustedEffectsFromTracker',
    );
    expect(rootAgentLoopSource).not.toContain('hasAgentRecoveryAttemptExhausted');
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentRecoveryExhaustedEffectsFromTracker',
    );
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentRecoveryExhaustedProjectionInputFromTracker',
    );
    expect(rootAgentLoopSource).not.toContain('buildAgentRecoveryExhaustedEffects(');
    expect(rootAgentLoopSource).not.toContain('emitAgentRecoveryEffects');
    expect(rootAgentLoopSource).not.toContain('runAgentRecoveryStateChangeHooks');
    expect(rootAgentLoopSource).not.toContain('const onRecoveryStateChange');
    expect(rootAgentLoopSource).not.toContain('onRecoveryStateChange?.(');
    expect(rootAgentLoopSource).not.toContain('recoveryHooks?.onStateChange?.(');
    expect(rootAgentLoopSource).not.toContain('consumeAgentRecoveryCompactStream(');
    expect(rootAgentLoopSource).not.toContain('function buildAbortResult');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopAbortResult');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopEndEvent');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopTurnEndEvent');
    expect(rootAgentLoopSource).not.toContain('if (signal?.aborted)');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopTurnStartEventInput');
    expect(rootAgentLoopSource).not.toContain('yield buildAgentLoopTurnStartEvent({');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopTurnRetryEventInput');
    expect(rootAgentLoopSource).not.toContain('yield buildAgentLoopTurnRetryEvent({');
    expect(rootAgentLoopSource).not.toContain('return {\n        success: true,');
    expect(rootAgentLoopSource).not.toContain('return buildAgentLoopSuccessResult');
    expect(rootAgentLoopSource).not.toContain("{ type: 'agent_start' }");
    expect(rootAgentLoopSource).not.toContain("{ type: 'agent_end' }");
    expect(rootAgentLoopSource).not.toContain("{ type: 'turn_start'");
    expect(rootAgentLoopSource).not.toContain("{ type: 'turn_end'");
    expect(rootAgentLoopSource).not.toContain("{ type: 'turn_retry'");
    expect(rootAgentLoopSource).not.toContain("{ type: 'thinking'");
    expect(rootAgentLoopSource).not.toContain("{ type: 'stream_end'");
    expect(rootAgentLoopSource).not.toContain('const usage: TokenUsageInfo =');
    expect(rootAgentLoopSource).not.toContain("{ type: 'token_usage'");
    expect(rootAgentLoopSource).not.toContain("{ type: 'budget_warning'");
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopBudgetWarningEvent');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopBudgetExhaustedResult');
    expect(rootAgentLoopSource).not.toContain('tokenBudget.record');
    expect(rootAgentLoopSource).not.toContain('tokenBudget.isWarning');
    expect(rootAgentLoopSource).not.toContain('tokenBudget.isApproachingLimit');
    expect(rootAgentLoopSource).not.toContain('tokenBudget.isDiminishingReturns');
    expect(rootAgentLoopSource).not.toContain('tokenBudget.isExhausted');
    expect(rootAgentLoopSource).not.toContain('if (budgetDecision.result)');
    expect(rootAgentLoopSource).not.toContain('return budgetDecision.result');
    expect(rootAgentLoopSource).not.toContain("limitDecision.action === 'stop'");
    expect(rootAgentLoopSource).not.toContain('return limitDecision.result');
    expect(rootAgentLoopSource).not.toContain('limitDecision.compactedMessages');
    expect(rootAgentLoopSource).not.toContain('limitDecision.continueMessage');
    expect(rootAgentLoopSource).not.toContain('const limitDecision = await decideTurnLimit({');
    expect(rootAgentLoopSource).not.toContain('turnLimitContinuation.shouldReplaceMessages');
    expect(rootAgentLoopSource).not.toContain("{\n          type: 'model_fallback'");
    expect(rootAgentLoopSource).not.toContain('buildAgentRecoveryProjection({');
    expect(rootAgentLoopSource).not.toContain("{ type: 'tool_result'");
    expect(rootAgentLoopSource).not.toContain('let totalTokens = 0');
    expect(rootAgentLoopSource).not.toContain('let lastPromptTokens');
    expect(rootAgentLoopSource).not.toContain('if (turnResult.usage)');
    expect(rootAgentLoopSource).not.toContain('aborted: Boolean(signal?.aborted)');
    expect(rootAgentLoopSource).not.toContain(
      'hasStreamingExecutionResults: streamingExecutionResults !== undefined,\n    }))',
    );
    expect(rootAgentLoopSource).not.toContain('const startTime = Date.now()');
    expect(rootAgentLoopSource).not.toContain("turnResult.content || ''");
    expect(rootAgentLoopSource).not.toContain("role: 'assistant',\n      content: turnResult.content || ''");
    expect(rootAgentLoopSource).not.toContain(
      'Agent loop completed without a chat response',
    );
    expect(rootAgentLoopSource).not.toContain('let turnsCount = 0');
    expect(rootAgentLoopSource).not.toContain('let retryCurrentTurn');
    expect(rootAgentLoopSource).not.toContain('let recovered = false');
    expect(rootAgentLoopSource).not.toContain('await compactStream.next()');
    expect(rootAgentLoopSource).not.toContain('if (turnStart.started)');
    expect(rootAgentLoopSource).not.toContain('turnCounter.shouldRunBeforeTurn() &&');
    expect(rootAgentLoopSource).not.toContain('beforeTurnStream.next()');
    expect(rootAgentLoopSource).not.toContain('const turnGen = runTurn({');
    expect(rootAgentLoopSource).not.toContain('turnGen.next()');
    expect(rootAgentLoopSource).not.toContain('const executionPlan = planToolExecution(');
    expect(rootAgentLoopSource).not.toContain('executionResults = await executeToolCalls({');
    expect(rootAgentLoopSource).not.toContain('turnsCount++');
    expect(rootAgentLoopSource).not.toContain('turnsCount = 0');
    expect(rootAgentLoopSource).not.toContain('let toolResultContent =');
    expect(rootAgentLoopSource).not.toContain('buildAgentToolResultContent');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopToolMessage');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopToolInjectedMessages');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopToolResultEvent');
    expect(rootAgentLoopSource).not.toContain('for (const event of buildAgentLoopToolStartEvents({');
    expect(rootAgentLoopSource).not.toContain('shouldEmitAgentLoopNonStreamingToolResultEffects');
    expect(rootAgentLoopSource).not.toContain("role: 'tool',\n        tool_call_id: toolCall.id");
    expect(rootAgentLoopSource).not.toContain('const toolDef = executionPipeline.getRegistry().get');
    expect(rootAgentLoopSource).not.toContain('const toolKind = toolDef?.kind');
    expect(rootAgentLoopSource).not.toContain('turnResult.toolCalls.filter');
    expect(rootAgentLoopSource).not.toContain('if (!executionResults)');
    expect(rootAgentLoopSource).not.toContain(
      'hasStreamingExecutionResults: streamingExecutionResults !== undefined,\n        ...loopClock.resultTiming',
    );
    expect(rootAgentLoopSource).not.toContain(
      '!turnResult.toolCalls || turnResult.toolCalls.length === 0',
    );
    expect(rootAgentLoopSource).not.toContain(
      "noToolDecision.action === 'retry' || noToolDecision.action === 'continue_with_reminder'",
    );
    expect(rootAgentLoopSource).not.toContain('const noToolDecision = await decideNoToolTurn(');
    expect(rootAgentLoopSource).not.toContain('convState.append(noToolDecision.message)');
    expect(rootAgentLoopSource).not.toContain('const messageHooks = hooks?.message');
    expect(rootAgentLoopSource).not.toContain('messageHooks?.onComplete');
    expect(rootAgentLoopSource).not.toContain('onComplete?.({ content, turn: turnsCount })');
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentLoopTurnEndEvent({ turn: turnsCount, hasToolCalls: false })',
    );
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentLoopTurnEndEvent({ turn: turnsCount, hasToolCalls: true })',
    );
    expect(rootAgentLoopSource).not.toContain("tc.type === 'function'");
    expect(rootAgentLoopSource).not.toContain('for (const toolCall of executionPlan.calls)');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopToolStartEvent({');
    expect(rootAgentLoopSource).not.toContain('as AgentEvent');
    expect(rootAgentLoopSource).not.toContain('const TOOL_RESULT_BUFFER = 50');
    expect(rootAgentLoopSource).not.toContain('const recentToolResults');
    expect(rootAgentLoopSource).not.toContain('const recordToolResult');
    expect(rootAgentLoopSource).not.toContain('result.newMessages && result.newMessages.length > 0');
    expect(rootAgentLoopSource).not.toContain('markToolInjectedSystemMessages');
    expect(rootAgentLoopSource).not.toContain('injectedMessages.length > 0');
    expect(rootAgentLoopSource).not.toContain('shouldAppendAgentLoopToolInjectedMessages');
    expect(rootAgentLoopSource).not.toContain('afterExec?.({ toolCall, result, toolUseUuid })');
    expect(rootAgentLoopSource).not.toContain('result.metadata?.shouldExitLoop');
    expect(rootAgentLoopSource).not.toContain("toolExitDecision.action === 'exit'");
    expect(rootAgentLoopSource).not.toContain('!streamingExecutionResults');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopToolExitFinalMessage');
    expect(rootAgentLoopSource).not.toContain('buildAgentLoopToolExitResult');
    expect(rootAgentLoopSource).not.toContain('let recoveryAttemptedTurn');
    expect(rootAgentLoopSource).not.toContain('let recoveryAttempt = 0');
    expect(rootAgentLoopSource).not.toContain('beforeTurnHook({');
    expect(rootAgentLoopSource).not.toContain(
      'handleAgentRunTurnErrorWithEmissions',
    );
    expect(rootAgentLoopSource).not.toContain(
      'handleAgentRunTurnSuccessWithEmissions',
    );
    expect(rootAgentLoopSource).not.toContain('assertAgentLoopTurnResponse');
    expect(rootAgentLoopSource).not.toContain('emitAgentRecoveryResetEffects');
    expect(rootAgentLoopSource).not.toContain(
      'handleAgentReactiveCompactRecoveryWithEmissions',
    );
    expect(rootAgentLoopSource).not.toContain(
      'handleAgentModelFallbackWithEmissions',
    );
    expect(rootAgentLoopSource).not.toContain(
      'emitAgentRecoveryExhaustedEffectsIfAttempted',
    );
    expect(rootAgentLoopSource).not.toContain(
      'shouldAttemptAgentRecoveryFromHookContainer',
    );
    expect(rootAgentLoopSource).not.toContain(
      'runAgentRecoveryCompactAttemptWithEmissions',
    );
    expect(rootAgentLoopSource).not.toContain('applyAgentLoopReactiveCompactRetry');
    expect(rootAgentLoopSource).not.toContain('hasAgentReactiveCompactHook');
    expect(rootAgentLoopSource).not.toContain(
      'buildAgentRecoveryCompactStreamFromHookContainer({',
    );
    expect(rootAgentLoopSource).not.toContain('const recoveryHooks = hooks?.recovery');
    expect(rootAgentLoopSource).not.toContain('hooks?.recovery?.reactiveCompact');
    expect(rootAgentLoopSource).not.toContain('recoveryHooks?.reactiveCompact');
    expect(rootAgentLoopSource).not.toContain('reactiveCompact?.({ messages: convState.toArray() })');
    expect(rootAgentLoopSource).not.toContain('compactStreamResult.recovered');
    expect(rootAgentLoopSource).not.toContain('consumeAgentRecoveryResetAttempt');
    expect(rootAgentLoopSource).not.toContain('consumeResetAttempt() !== null');
    expect(rootAgentLoopSource).not.toContain('isOverflowRecoverable(llmError)');
    expect(rootAgentLoopSource).not.toContain('recoveryAttemptTracker.canAttempt(turnsCount)');
    expect(rootAgentLoopSource).not.toContain(
      'recoveryAttemptTracker.hasAttemptedTurn(turnsCount)',
    );
    expect(rootAgentLoopSource).not.toContain('buildAgentRecoveryProjection(');
    expect(rootAgentLoopSource).not.toContain('buildAgentRecoveryEffects(');
    expect(rootAgentLoopSource).not.toContain("kind: 'started'");
    expect(rootAgentLoopSource).not.toContain("kind: 'compact_failed'");
    expect(rootAgentLoopSource).not.toContain("kind: 'retrying'");
    expect(rootAgentLoopSource).not.toContain("reason: 'reactive_compact_failed'");
    expect(rootAgentLoopSource).not.toContain("reason: 'reactive_compact_retry'");
    expect(rootAgentLoopSource).not.toContain("reason: 'reactive_compact'");
    expect(rootAgentLoopSource).not.toContain("reason: 'recovery_exhausted'");
    expect(rootAgentLoopSource).not.toContain("kind: 'reset'");
    expect(rootAgentLoopSource).not.toContain("phase: 'reset',\n        attempt: 0");
    expect(rootAgentLoopSource).not.toContain('shouldEmitAgentRecoveryEvent');
    expect(rootAgentLoopSource).not.toContain('recoveryStarted.stateChange');
    expect(rootAgentLoopSource).not.toContain('recoveryFailed.stateChange');
    expect(rootAgentLoopSource).not.toContain('recoveryRetrying.stateChange');
    expect(rootAgentLoopSource).not.toContain('recoveryExhausted.stateChange');
    expect(rootAgentLoopSource).not.toContain('recoveryReset.stateChange');
    expect(rootAgentLoopSource).not.toContain('for (const event of recovery');
    expect(rootAgentLoopSource).not.toMatch(
      /for \(const event of recovery[A-Za-z]+Effects\.events\)/,
    );
    expect(rootAgentLoopSource).not.toContain('if (recoveryStarted.event)');
    expect(rootAgentLoopSource).not.toContain('if (recoveryFailed.event)');
    expect(rootAgentLoopSource).not.toContain('if (recoveryRetrying.event)');
    expect(rootAgentLoopSource).not.toContain('if (recoveryExhausted.event)');
    expect(rootAgentLoopSource).not.toContain("_systemSource: 'tool_injection' as const");
    expect(rootAgentLoopSource).not.toContain('shouldExitLoop: true,\n            targetMode:');
    expect(rootAgentLoopSource).not.toContain('循环已退出');
    expect(rootAgentLoopSource).not.toContain('message: \'Token budget exhausted\'');
    expect(rootAgentLoopSource).not.toContain(
      'message: \'Stopped due to diminishing returns: consecutive turns produced very few tokens\'',
    );
    expect(rootAgentLoopSource).not.toContain('const _turnTools = turnState.tools');
    expect(rootAgentLoopSource).not.toContain(
      'const turnMaxContextTokens = turnState.maxContextTokens',
    );
    expect(rootAgentLoopSource).not.toContain(
      'const turnPermissionMode = turnState.permissionMode',
    );
    expect(rootAgentLoopSource).not.toContain(
      'const turnExecutionContext = turnState.executionContext',
    );
    expect(rootAgentLoopSource).not.toContain("import { AGENT_TURN_SAFETY_LIMIT } from './constants.js'");
    expect(rootAgentLoopSource).not.toContain(
      'const effectiveMaxTurns = isYoloMode ? AGENT_TURN_SAFETY_LIMIT : maxTurns',
    );
    expect(rootAgentLoopSource).not.toContain(
      'turnsCount >= effectiveMaxTurns && !isYoloMode',
    );
    expect(rootAgentLoopSource).not.toContain('epoch && !epoch.isValid');
    expect(agentRecoverySource).toContain("from './isOverflowRecoverable.js'");
    expect(agentRecoverySource).toContain("from './recoveryAttemptTracker.js'");
    expect(agentRecoverySource).toContain("from './recoveryEvents.js'");
    expect(agentStateSource).toContain("from './systemSource.js'");
    expect(agentStateSource).toContain("from './toolInjectedMessages.js'");
  });

  it('keeps loop hook builder from depending on the AgentLoop facade', () => {
    const loopHookBuilderSource = readFileSync('src/agent/LoopHookBuilder.ts', 'utf-8');

    expect(loopHookBuilderSource).not.toContain("from './AgentLoop.js'");
  });

  it('keeps root loop forwarders on public package subpaths', () => {
    const rootTsconfig = readJson('tsconfig.json');
    const rootLoopForwarders = [
      'src/agent/loop/AsyncEventQueue.ts',
      'src/agent/loop/agentLoop.ts',
      'src/agent/loop/assistantMessage.ts',
      'src/agent/loop/decideNoToolTurn.ts',
      'src/agent/loop/decideTurnLimit.ts',
      'src/agent/loop/loopClock.ts',
      'src/agent/loop/loopEvents.ts',
      'src/agent/loop/loopResult.ts',
      'src/agent/loop/modelResponseTurn.ts',
      'src/agent/loop/planToolExecution.ts',
      'src/agent/loop/repairToolCallParams.ts',
      'src/agent/loop/responseEvents.ts',
      'src/agent/loop/runTurnWithRecovery.ts',
      'src/agent/loop/tokenUsage.ts',
      'src/agent/loop/tokenUsageTracker.ts',
      'src/agent/loop/toolExecutionTurn.ts',
      'src/agent/loop/toolInjectedMessages.ts',
      'src/agent/loop/toolInterruptBehavior.ts',
      'src/agent/loop/toolMessage.ts',
      'src/agent/loop/toolResponseTurn.ts',
      'src/agent/loop/toolResultContent.ts',
      'src/agent/loop/toolResultContinuation.ts',
      'src/agent/loop/toolResultTracker.ts',
      'src/agent/loop/toolStartEvent.ts',
      'src/agent/loop/turnCounter.ts',
      'src/agent/loop/turnCycle.ts',
      'src/agent/loop/turnEntry.ts',
      'src/agent/loop/turnState.ts',
      'src/agent/loop/turnStream.ts',
    ] as const;

    expect(rootTsconfig.compilerOptions?.paths).toMatchObject({
      '@blade-ai/agent/loop': ['./packages/agent/src/loop/index.ts'],
    });
    for (const file of rootLoopForwarders) {
      const source = readFileSync(file, 'utf-8');
      expect(source, file).toContain("from '@blade-ai/agent/loop'");
      expect(source, file).not.toContain('../../../packages/agent/src');
    }
  });

  it('keeps the root tool-update adapter on the public loop package subpath', () => {
    const source = readFileSync('src/agent/loop/toolUpdateToAgentEvent.ts', 'utf-8');

    expect(source.trim()).toBe(
      [
        'export {',
        '  buildAgentLoopToolResultEvent,',
        '  toolUpdateToAgentEvent,',
        "} from '@blade-ai/agent/loop';",
      ].join('\n'),
    );
  });

  it('centralizes tool execution plan scheduling in the public agent loop package', () => {
    const loopIndexSource = readFileSync('packages/agent/src/loop/index.ts', 'utf-8');
    const rootExecutionSource = readFileSync(
      'src/agent/loop/executeToolCalls.ts',
      'utf-8',
    );
    const packageExecutionSource = readFileSync(
      'packages/agent-sdk/src/session/runtimeToolExecution.ts',
      'utf-8',
    );

    expect(existsSync('packages/agent/src/loop/executeToolExecutionPlan.ts')).toBe(true);
    expect(existsSync('packages/agent/src/__tests__/executeToolExecutionPlan.test.ts')).toBe(true);
    expect(loopIndexSource).toContain("export * from './executeToolExecutionPlan.js';");

    for (const [file, source] of [
      ['src/agent/loop/executeToolCalls.ts', rootExecutionSource],
      ['packages/agent-sdk/src/session/runtimeToolExecution.ts', packageExecutionSource],
    ] as const) {
      expect(source, file).toMatch(
        /import\s*\{[^}]*\bexecuteToolExecutionPlan\b[^}]*\}\s*from '@blade-ai\/agent\/loop';/,
      );
      expect(source, file).not.toMatch(/plan\.mode\s*===/);
      expect(source, file).not.toMatch(/async function \w*WithConcurrency\(/);
      expect(source, file).not.toContain('workerCount');
    }
  });

  it('keeps tool-ready compatibility dispatch explicit in the root legacy loop adapter', () => {
    const rootExecutionSource = readFileSync(
      'src/agent/loop/executeToolCalls.ts',
      'utf-8',
    );
    const rootRunToolCallSource = readFileSync('src/agent/loop/runToolCall.ts', 'utf-8');

    expect(rootRunToolCallSource).not.toContain('emitToolExecutionUpdate');
    expect(rootRunToolCallSource).not.toContain('switch (update.type)');
    expect(rootRunToolCallSource).not.toContain('await hooks?.onUpdate?.(update)');

    expect(rootExecutionSource).not.toContain('emitToolExecutionUpdate');
    expect(rootExecutionSource).toMatch(
      /import type\s*\{[^}]*\bToolExecutionUpdate\b[^}]*\}\s*from '\.\/runToolCall\.js';/,
    );
    expect(rootExecutionSource).toContain('const readyUpdate: ToolExecutionUpdate = {');
    expect(rootExecutionSource.match(/type: 'tool_\w+'/g)).toEqual(["type: 'tool_ready'"]);

    const onUpdateIndex = rootExecutionSource.indexOf(
      'await input.hooks?.onUpdate?.(readyUpdate);',
    );
    const onToolReadyIndex = rootExecutionSource.indexOf(
      'await input.hooks?.onToolReady?.(toolCall);',
    );
    const runToolCallIndex = rootExecutionSource.indexOf('return runToolCall({');

    expect(onUpdateIndex).toBeGreaterThan(-1);
    expect(onToolReadyIndex).toBeGreaterThan(onUpdateIndex);
    expect(runToolCallIndex).toBeGreaterThan(onToolReadyIndex);
  });

  it('keeps root legacy loop adapters on the agent-sdk session internal subpath', () => {
    const rootTsconfig = readJson('tsconfig.json');
    const sdkPackage = readJson('packages/agent-sdk/package.json');
    const sdkTsupConfig = readFileSync('packages/agent-sdk/tsup.config.ts', 'utf-8');
    const rootVitestConfig = readFileSync('vitest.config.ts', 'utf-8');
    const rootLegacyLoopAdapters = [
      'src/agent/loop/runToolCall.ts',
      'src/agent/loop/runTurn.ts',
    ] as const;
    const retiredRootLoopAdapters = [
      'src/agent/loop/executeToolCalls.ts',
    ] as const;

    expect(existsSync('packages/agent-sdk/src/session/internal.ts')).toBe(true);
    expect(existsSync('src/agent/loop/streamChatResponse.ts')).toBe(false);
    expect(sdkPackage.exports?.['./session/internal']).toEqual({
      types: './dist/session/internal.d.ts',
      browser: './dist/browser/server-only-stub.js',
      import: './dist/session/internal.js',
    });
    expect(sdkTsupConfig).toContain("'session/internal': 'src/session/internal.ts'");
    expect(rootTsconfig.compilerOptions?.paths).toMatchObject({
      '@blade-ai/agent-sdk/session/internal': [
        './packages/agent-sdk/src/session/internal.ts',
      ],
    });
    expect(rootVitestConfig).toContain("'@blade-ai/agent-sdk/session/internal'");
    expect(rootVitestConfig).toContain('packages/agent-sdk/src/session/internal.ts');

    const internalEntrySource = readFileSync('packages/agent-sdk/src/session/internal.ts', 'utf-8');
    const serverOnlyStubSource = readFileSync(
      'packages/agent-sdk/src/browser/server-only-stub.ts',
      'utf-8',
    );

    expect(internalEntrySource).not.toContain('export *');
    expect(internalEntrySource).toContain('runPackageLocalTurn');
    expect(internalEntrySource).not.toContain('PackageLocalRunTurnEvent');
    expect(internalEntrySource).not.toContain('PackageLocalRunTurnInput');
    expect(internalEntrySource).not.toContain('PackageLocalRunTurnToolHooks');
    expect(internalEntrySource).not.toContain('PackageLocalTurnOutcome');
    expect(internalEntrySource).not.toContain('executePackageLocalToolCalls');
    expect(internalEntrySource).not.toContain('emitPackageLocalToolExecutionUpdate');
    expect(internalEntrySource).toContain('runPackageLocalToolCall');
    expect(internalEntrySource).not.toContain('PackageLocalRunToolCallInput');
    expect(internalEntrySource).not.toContain('PackageLocalStreamingToolExecutor');
    expect(internalEntrySource).not.toContain('PackageLocalStreamingToolExecutorConfig');
    expect(serverOnlyStubSource).toContain('runPackageLocalTurn');
    expect(serverOnlyStubSource).toContain('runPackageLocalToolCall');

    for (const file of rootLegacyLoopAdapters) {
      const source = readFileSync(file, 'utf-8');
      expect(source, file).toContain("from '@blade-ai/agent-sdk/session/internal'");
      expect(source, file).not.toContain('packages/agent-sdk/src');
    }

    for (const file of retiredRootLoopAdapters) {
      const source = readFileSync(file, 'utf-8');
      expect(source, file).not.toContain("from '@blade-ai/agent-sdk/session/internal'");
      expect(source, file).not.toContain('packages/agent-sdk/src');
    }
  });

  it('keeps root recovery, state, and epoch forwarders on public package subpaths', () => {
    const rootTsconfig = readJson('tsconfig.json');
    const rootAgentForwarders = [
      ['src/agent/recoveryEvents.ts', '@blade-ai/agent/recovery'],
      ['src/agent/recoveryAttemptTracker.ts', '@blade-ai/agent/recovery'],
      ['src/agent/isOverflowRecoverable.ts', '@blade-ai/agent/recovery'],
      ['src/agent/ExecutionEpoch.ts', '@blade-ai/agent/epoch'],
      ['src/agent/state/systemSource.ts', '@blade-ai/agent/state'],
      ['src/agent/state/toolInjectedMessages.ts', '@blade-ai/agent/state'],
    ] as const;

    expect(rootTsconfig.compilerOptions?.paths).toMatchObject({
      '@blade-ai/agent/epoch': ['./packages/agent/src/epoch/ExecutionEpoch.ts'],
      '@blade-ai/agent/recovery': ['./packages/agent/src/recovery/index.ts'],
      '@blade-ai/agent/state': ['./packages/agent/src/state/index.ts'],
    });
    for (const [file, publicSubpath] of rootAgentForwarders) {
      const source = readFileSync(file, 'utf-8');
      expect(source, file).toContain(`from '${publicSubpath}'`);
      expect(source, file).not.toContain('packages/agent/src');
    }
  });

  it('keeps root runtime off legacy epoch and state forwarders', () => {
    const runtimeConsumers = [
      [
        'src/agent/loop/rootAgentLoopAdapter.ts',
        '@blade-ai/agent/epoch',
        /from ['"]\.\.\/ExecutionEpoch\.js['"]/,
      ],
      [
        'src/agent/loop/runTurn.ts',
        '@blade-ai/agent/epoch',
        /from ['"]\.\.\/ExecutionEpoch\.js['"]/,
      ],
      [
        'src/agent/LoopRunner.ts',
        '@blade-ai/agent/state',
        /from ['"]\.\/state\/systemSource\.js['"]/,
      ],
    ] as const;

    for (const [file, publicSubpath, legacyImport] of runtimeConsumers) {
      const source = readFileSync(file, 'utf-8');

      expect(source, `${file} should import from ${publicSubpath}`).toContain(
        `from '${publicSubpath}'`,
      );
      expect(source, `${file} should not import the legacy root forwarder`).not.toMatch(
        legacyImport,
      );
    }
  });

  it('publishes agent kernel modules as explicit subpath exports', () => {
    const agentPackage = readJson('packages/agent/package.json');
    const agentBuildConfig = readFileSync('packages/agent/tsup.config.ts', 'utf-8');

    expect(agentPackage.exports).toMatchObject({
      './kernel': {
        types: './dist/kernel/AgentKernel.d.ts',
        import: './dist/kernel/AgentKernel.js',
      },
      './loop': {
        types: './dist/loop/index.d.ts',
        import: './dist/loop/index.js',
      },
      './budget': {
        types: './dist/budget/TokenBudget.d.ts',
        import: './dist/budget/TokenBudget.js',
      },
      './epoch': {
        types: './dist/epoch/ExecutionEpoch.d.ts',
        import: './dist/epoch/ExecutionEpoch.js',
      },
      './protocol': {
        types: './dist/protocol/index.d.ts',
        import: './dist/protocol/index.js',
      },
      './ports': {
        types: './dist/ports/index.d.ts',
        import: './dist/ports/index.js',
      },
      './recovery': {
        types: './dist/recovery/index.d.ts',
        import: './dist/recovery/index.js',
      },
      './state': {
        types: './dist/state/index.d.ts',
        import: './dist/state/index.js',
      },
      './tracing': {
        types: './dist/tracing/index.d.ts',
        import: './dist/tracing/index.js',
      },
    });
    expect(agentBuildConfig).toContain('kernel/AgentKernel');
    expect(agentBuildConfig).toContain('loop/index');
    expect(agentBuildConfig).toContain('budget/TokenBudget');
    expect(agentBuildConfig).toContain('epoch/ExecutionEpoch');
    expect(agentBuildConfig).toContain('protocol/index');
    expect(agentBuildConfig).toContain('ports/index');
    expect(agentBuildConfig).toContain('recovery/index');
    expect(agentBuildConfig).toContain('state/index');
    expect(agentBuildConfig).toContain('tracing/index');
  });

  it('owns core observability contracts inside agent-sdk', () => {
    expect(existsSync('packages/agent-sdk/src/observability/types.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/observability/TraceRecorder.ts')).toBe(true);

    const coreSource = readFileSync('packages/agent-sdk/src/core/index.ts', 'utf-8');
    const traceRecorderSource = readFileSync(
      'packages/agent-sdk/src/observability/TraceRecorder.ts',
      'utf-8',
    );

    expect(coreSource).not.toContain('../../../../src/observability/index.js');
    expect(traceRecorderSource).not.toContain('../../../../src/');
    expect(traceRecorderSource).toContain("from './types.js'");
  });

  it('owns core runtime contracts inside agent-sdk', () => {
    expect(existsSync('packages/agent-sdk/src/runtime/types.ts')).toBe(true);

    const coreSource = readFileSync('packages/agent-sdk/src/core/index.ts', 'utf-8');

    expect(coreSource).not.toContain('../../../../src/runtime/index.js');
  });

  it('owns core session stream contracts inside agent-sdk', () => {
    expect(existsSync('packages/agent-sdk/src/session/types.ts')).toBe(true);

    const coreSource = readFileSync('packages/agent-sdk/src/core/index.ts', 'utf-8');

    expect(coreSource).not.toContain('../../../../src/session/types.js');
  });

  it('owns the public session entry source inside agent-sdk', () => {
    const sessionSource = readFileSync('packages/agent-sdk/src/session/index.ts', 'utf-8');
    const sessionConfigSource = readFileSync('packages/agent-sdk/src/session/config.ts', 'utf-8');
    const sessionRuntimeFactorySource = readFileSync(
      'packages/agent-sdk/src/session/runtimeFactory.ts',
      'utf-8',
    );
    const sessionContentSource = readFileSync('packages/agent-sdk/src/session/content.ts', 'utf-8');
    const sessionPendingTurnSource = readFileSync(
      'packages/agent-sdk/src/session/pendingTurn.ts',
      'utf-8',
    );
    const sessionTurnAbortSource = readFileSync(
      'packages/agent-sdk/src/session/turnAbort.ts',
      'utf-8',
    );
    const sessionTurnSource = readFileSync('packages/agent-sdk/src/session/turn.ts', 'utf-8');
    const sessionPromptAccumulatorSource = readFileSync(
      'packages/agent-sdk/src/session/promptStreamAccumulator.ts',
      'utf-8',
    );
    const sessionCleanupSource = readFileSync('packages/agent-sdk/src/session/cleanup.ts', 'utf-8');
    const sessionLifecycleStateSource = readFileSync(
      'packages/agent-sdk/src/session/lifecycle.ts',
      'utf-8',
    );
    const sessionTracesSource = readFileSync('packages/agent-sdk/src/session/traces.ts', 'utf-8');
    const sessionKernelStreamBridgeSource = readFileSync(
      'packages/agent-sdk/src/session/kernelStreamBridge.ts',
      'utf-8',
    );
    const sessionKernelStreamProjectionSource = existsSync(
      'packages/agent-sdk/src/session/kernelStreamProjection.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/kernelStreamProjection.ts', 'utf-8')
      : '';
    const sessionInstanceSource = readFileSync(
      'packages/agent-sdk/src/session/sessionInstance.ts',
      'utf-8',
    );
    const packageLocalRuntimeFactorySource = readFileSync(
      'packages/agent-sdk/src/session/packageLocalRuntimeFactory.ts',
      'utf-8',
    );
    const packageLocalKernelRuntimeFactorySource = readFileSync(
      'packages/agent-sdk/src/session/packageLocalKernelRuntimeFactory.ts',
      'utf-8',
    );
    const defaultKernelRuntimeFactorySource = readFileSync(
      'packages/agent-sdk/src/session/defaultKernelRuntimeFactory.ts',
      'utf-8',
    );
    const kernelModelResolverSource = readFileSync(
      'packages/agent-sdk/src/session/kernelModelResolver.ts',
      'utf-8',
    );
    const kernelFactorySource = readFileSync(
      'packages/agent-sdk/src/session/kernelFactory.ts',
      'utf-8',
    );
    const packageLocalRuntimeInstanceSource = readFileSync(
      'packages/agent-sdk/src/session/runtimeInstance.ts',
      'utf-8',
    );
    const runtimePortsSource = existsSync('packages/agent-sdk/src/session/runtimePorts.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimePorts.ts', 'utf-8')
      : '';
    const runtimeStateSource = existsSync('packages/agent-sdk/src/session/runtimeState.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeState.ts', 'utf-8')
      : '';
    const kernelStreamBridgeSource = readFileSync(
      'packages/agent-sdk/src/session/kernelStreamBridge.ts',
      'utf-8',
    );
    const runtimeMcpToolsSource = existsSync('packages/agent-sdk/src/session/runtimeMcpTools.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeMcpTools.ts', 'utf-8')
      : '';
    const runtimeMcpSource = existsSync('packages/agent-sdk/src/session/runtimeMcp.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeMcp.ts', 'utf-8')
      : '';
    const runtimeMcpServersSource = existsSync(
      'packages/agent-sdk/src/session/runtimeMcpServers.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeMcpServers.ts', 'utf-8')
      : '';
    const runtimeSessionLifecycleSource = existsSync(
      'packages/agent-sdk/src/session/runtimeSessionLifecycle.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeSessionLifecycle.ts', 'utf-8')
      : '';
    const runtimeSessionOperationsSource = existsSync(
      'packages/agent-sdk/src/session/runtimeSessionOperations.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeSessionOperations.ts', 'utf-8')
      : '';
    const runtimeSessionCapabilitiesSource = existsSync(
      'packages/agent-sdk/src/session/runtimeSessionCapabilities.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeSessionCapabilities.ts', 'utf-8')
      : '';
    const runtimeCapabilitiesSource = existsSync(
      'packages/agent-sdk/src/session/runtimeCapabilities.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeCapabilities.ts', 'utf-8')
      : '';
    const runtimeControlsSource = existsSync('packages/agent-sdk/src/session/runtimeControls.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeControls.ts', 'utf-8')
      : '';
    const runtimeMcpCapabilitiesSource = existsSync(
      'packages/agent-sdk/src/session/runtimeMcpCapabilities.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeMcpCapabilities.ts', 'utf-8')
      : '';
    const runtimeForkingSource = existsSync('packages/agent-sdk/src/session/runtimeForking.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeForking.ts', 'utf-8')
      : '';
    const runtimeToolFiltersSource = existsSync(
      'packages/agent-sdk/src/session/runtimeToolFilters.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeToolFilters.ts', 'utf-8')
      : '';
    const runtimeToolRegistrationSource = existsSync(
      'packages/agent-sdk/src/session/runtimeToolRegistration.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeToolRegistration.ts', 'utf-8')
      : '';
    const runtimeToolsSource = existsSync('packages/agent-sdk/src/session/runtimeTools.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeTools.ts', 'utf-8')
      : '';
    const runtimePermissionsSource = existsSync(
      'packages/agent-sdk/src/session/runtimePermissions.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimePermissions.ts', 'utf-8')
      : '';
    const runtimeHooksSource = existsSync('packages/agent-sdk/src/session/runtimeHooks.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeHooks.ts', 'utf-8')
      : '';
    const runtimeGuardsSource = existsSync('packages/agent-sdk/src/session/runtimeGuards.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeGuards.ts', 'utf-8')
      : '';
    const runtimeTraceManagerSource = existsSync(
      'packages/agent-sdk/src/session/runtimeTraceManager.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeTraceManager.ts', 'utf-8')
      : '';
    const runtimeExecutionPipelineSource = existsSync(
      'packages/agent-sdk/src/session/runtimeExecutionPipeline.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeExecutionPipeline.ts', 'utf-8')
      : '';
    const runtimeExecutionSource = existsSync(
      'packages/agent-sdk/src/session/runtimeExecution.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeExecution.ts', 'utf-8')
      : '';
    const runtimeToolExecutionSource = existsSync(
      'packages/agent-sdk/src/session/runtimeToolExecution.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeToolExecution.ts', 'utf-8')
      : '';
    const runtimeRunTurnSource = existsSync(
      'packages/agent-sdk/src/session/runtimeRunTurn.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeRunTurn.ts', 'utf-8')
      : '';
    const rootRunToolCallSource = existsSync('src/agent/loop/runToolCall.ts')
      ? readFileSync('src/agent/loop/runToolCall.ts', 'utf-8')
      : '';
    const rootRunTurnSource = existsSync('src/agent/loop/runTurn.ts')
      ? readFileSync('src/agent/loop/runTurn.ts', 'utf-8')
      : '';
    const streamingToolExecutorSource = existsSync(
      'packages/agent-sdk/src/session/streamingToolExecutor.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/streamingToolExecutor.ts', 'utf-8')
      : '';
    const streamChatResponseSource = existsSync(
      'packages/agent-sdk/src/session/streamChatResponse.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/streamChatResponse.ts', 'utf-8')
      : '';
    const runtimeAgentKernelsSource = existsSync(
      'packages/agent-sdk/src/session/runtimeAgentKernels.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeAgentKernels.ts', 'utf-8')
      : '';
    const runtimeKernelPortsSource = existsSync(
      'packages/agent-sdk/src/session/runtimeKernelPorts.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeKernelPorts.ts', 'utf-8')
      : '';
    const runtimeKernelSource = existsSync('packages/agent-sdk/src/session/runtimeKernel.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeKernel.ts', 'utf-8')
      : '';
    const runtimeAgentDepsSource = existsSync(
      'packages/agent-sdk/src/session/runtimeAgentDeps.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeAgentDeps.ts', 'utf-8')
      : '';
    const runtimeKernelTraceFinalizationSource = existsSync(
      'packages/agent-sdk/src/session/runtimeKernelTraceFinalization.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeKernelTraceFinalization.ts', 'utf-8')
      : '';
    const runtimeKernelTurnStreamSource = existsSync(
      'packages/agent-sdk/src/session/runtimeKernelTurnStream.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeKernelTurnStream.ts', 'utf-8')
      : '';
    const runtimeTurnSource = existsSync('packages/agent-sdk/src/session/runtimeTurn.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeTurn.ts', 'utf-8')
      : '';
    const runtimeKernelModelsSource = existsSync(
      'packages/agent-sdk/src/session/runtimeKernelModels.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeKernelModels.ts', 'utf-8')
      : '';
    const runtimeNoopPortsSource = existsSync('packages/agent-sdk/src/session/runtimeNoopPorts.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeNoopPorts.ts', 'utf-8')
      : '';
    const runtimeBootstrapSource = existsSync('packages/agent-sdk/src/session/runtimeBootstrap.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeBootstrap.ts', 'utf-8')
      : '';
    const runtimePortProjectionSource = existsSync(
      'packages/agent-sdk/src/session/runtimePortProjection.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimePortProjection.ts', 'utf-8')
      : '';
    const runtimeConnectionOperationsSource = existsSync(
      'packages/agent-sdk/src/session/runtimeConnectionOperations.ts',
    )
      ? readFileSync('packages/agent-sdk/src/session/runtimeConnectionOperations.ts', 'utf-8')
      : '';
    const runtimeSubagentsSource = existsSync('packages/agent-sdk/src/session/runtimeSubagents.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeSubagents.ts', 'utf-8')
      : '';
    const runtimeContextSource = existsSync('packages/agent-sdk/src/session/runtimeContext.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeContext.ts', 'utf-8')
      : '';
    const runtimeWorkspaceSource = existsSync('packages/agent-sdk/src/session/runtimeWorkspace.ts')
      ? readFileSync('packages/agent-sdk/src/session/runtimeWorkspace.ts', 'utf-8')
      : '';
    const sessionFactorySource = readFileSync('packages/agent-sdk/src/session/factory.ts', 'utf-8');
    const sessionLifecycleSource = readFileSync('packages/agent-sdk/src/session/Session.ts', 'utf-8');
    const sessionStoreSource = readFileSync('packages/agent-sdk/src/session/store.ts', 'utf-8');
    const sessionTypesSource = readFileSync('packages/agent-sdk/src/session/types.ts', 'utf-8');

    expect(sessionSource).not.toContain("export * from '../../../../src/session/index.js'");
    expect(sessionSource).not.toContain("../../../../src/session/Session.js");
    expect(existsSync('packages/agent-sdk/src/session/Session.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/legacySessionAdapter.ts')).toBe(false);
    expect(existsSync('packages/agent-sdk/src/session/config.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/content.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/pendingTurn.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/turnAbort.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/turn.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/promptStreamAccumulator.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/cleanup.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/lifecycle.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/traces.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/legacyStreamEvents.ts')).toBe(false);
    expect(existsSync('packages/agent-sdk/src/session/taskCompleted.ts')).toBe(false);
    expect(existsSync('packages/agent-sdk/src/session/streamCompletion.ts')).toBe(false);
    expect(existsSync('packages/agent-sdk/src/session/promptSubmit.ts')).toBe(false);
    expect(existsSync('packages/agent-sdk/src/session/legacyStreamRunner.ts')).toBe(false);
    expect(existsSync('packages/agent-sdk/src/session/legacyStreamBridge.ts')).toBe(false);
    expect(existsSync('packages/agent-sdk/src/session/packageLocalLegacyRuntimeFactory.ts')).toBe(false);
    expect(existsSync('packages/agent-sdk/src/session/sessionInstance.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/runtimeInstance.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/packageLocalRuntimeFactory.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/store.ts')).toBe(true);
    expect(sessionContentSource).not.toContain('../../../../src/');
    expect(sessionPendingTurnSource).not.toContain('../../../../src/');
    expect(sessionTurnAbortSource).not.toContain('../../../../src/');
    expect(sessionTurnSource).not.toContain('../../../../src/');
    expect(sessionTurnSource).toContain('createSessionContextSnapshot');
    expect(sessionTurnSource).toContain('class SessionTurnController');
    expect(sessionPromptAccumulatorSource).not.toContain('../../../../src/');
    expect(sessionCleanupSource).not.toContain('../../../../src/');
    expect(sessionLifecycleStateSource).not.toContain('../../../../src/');
    expect(sessionTracesSource).not.toContain('../../../../src/');
    expect(sessionTracesSource).toContain('../observability/TraceRecorder.js');
    expect(sessionTracesSource).toContain('createSessionTraceFinalizer');
    expect(existsSync('packages/agent-sdk/src/session/kernelStreamBridge.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/session/kernelStreamProjection.ts')).toBe(true);
    expect(sessionKernelStreamBridgeSource).not.toContain('../../../../src/');
    expect(sessionKernelStreamBridgeSource).toContain('createKernelStreamTurnBridge');
    expect(sessionKernelStreamBridgeSource).toContain('streamAgentKernelTurn');
    expect(sessionKernelStreamBridgeSource).toContain('getUserMessageText');
    expect(sessionKernelStreamProjectionSource).not.toContain('../../../../src/');
    expect(sessionKernelStreamProjectionSource).toContain(
      'projectPackageLocalKernelEventToStreamMessages',
    );
    expect(sessionInstanceSource).not.toContain('../../../../src/');
    expect(sessionInstanceSource).toContain('class PackageLocalSession');
    expect(sessionInstanceSource).not.toContain('PackageLocalSessionDelegate');
    expect(sessionInstanceSource).not.toContain('delegate?:');
    expect(sessionInstanceSource).not.toContain('this.delegate');
    expect(existsSync('packages/agent-sdk/src/session/legacySessionDelegate.ts')).toBe(false);
    expect(packageLocalRuntimeFactorySource).not.toContain('../../../../src/');
    expect(packageLocalRuntimeFactorySource).toContain('createPackageLocalSessionRuntimeFactory');
    expect(packageLocalRuntimeInstanceSource).not.toContain('../../../../src/');
    expect(packageLocalRuntimeInstanceSource).toContain('class PackageLocalSessionRuntime');
    expect(existsSync('packages/agent-sdk/src/session/runtimePorts.ts')).toBe(true);
    expect(runtimePortsSource).not.toContain('../../../../src/');
    expect(runtimePortsSource).toContain('interface PackageLocalSessionRuntimeOptions');
    expect(runtimePortsSource).toContain('interface PackageLocalRuntimeMcpRegistryPort');
    expect(runtimePortsSource).toContain('interface PackageLocalRuntimeToolCatalogPort');
    expect(runtimePortsSource).toContain('interface PackageLocalRuntimeSubagentRegistryPort');
    expect(packageLocalRuntimeInstanceSource).toContain("from './runtimePorts.js'");
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'export interface PackageLocalRuntimeSessionStorePort',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'export interface PackageLocalRuntimeMcpRegistryPort',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'export interface PackageLocalRuntimeToolCatalogPort',
    );
    expect(existsSync('packages/agent-sdk/src/session/runtimeNoopPorts.ts')).toBe(true);
    expect(runtimeNoopPortsSource).not.toContain('../../../../src/');
    expect(runtimeNoopPortsSource).toContain('createPackageLocalRuntimeNoopPorts');
    expect(runtimeNoopPortsSource).toContain('resolvePackageLocalRuntimePorts');
    expect(existsSync('packages/agent-sdk/src/session/runtimeBootstrap.ts')).toBe(true);
    expect(runtimeBootstrapSource).not.toContain('../../../../src/');
    expect(runtimeBootstrapSource).toContain('createPackageLocalRuntimeBootstrap');
    expect(runtimeBootstrapSource).toContain('createPackageLocalRuntimeInitialState');
    expect(runtimeBootstrapSource).toContain('resolvePackageLocalRuntimePorts');
    expect(packageLocalRuntimeInstanceSource).toContain('createPackageLocalRuntimeBootstrap');
    expect(packageLocalRuntimeInstanceSource).not.toContain('resolvePackageLocalRuntimePorts');
    expect(existsSync('packages/agent-sdk/src/session/runtimeTokenBudget.ts')).toBe(true);
    expect(packageLocalRuntimeInstanceSource).toContain(
      'createPackageLocalRuntimeTokenBudgetOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('tokenBudgetOperations.apply');
    expect(packageLocalRuntimeInstanceSource).not.toContain("from '@blade-ai/agent/budget'");
    expect(packageLocalRuntimeInstanceSource).not.toContain('new TokenBudget');
    expect(packageLocalRuntimeInstanceSource).not.toContain('withSessionTokenBudget');
    expect(existsSync('packages/agent-sdk/src/session/runtimePortProjection.ts')).toBe(true);
    expect(runtimePortProjectionSource).not.toContain('../../../../src/');
    expect(runtimePortProjectionSource).toContain('projectPackageLocalRuntimePortFields');
    expect(packageLocalRuntimeInstanceSource).toContain('projectPackageLocalRuntimePortFields');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.sessionStore = runtimePorts.sessionStore',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.kernelModelResolver = runtimePorts.kernelModelResolver',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('const noopPorts');
    expect(packageLocalRuntimeInstanceSource).not.toContain('?? noopPorts.');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.hookManager = options.hookManager ?? this.hookRuntime',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('function createNoopRuntime');
    expect(existsSync('packages/agent-sdk/src/session/runtimeState.ts')).toBe(true);
    expect(runtimeStateSource).not.toContain('../../../../src/');
    expect(runtimeStateSource).toContain('createPackageLocalRuntimeInitialState');
    expect(runtimeStateSource).toContain('resolvePackageLocalRuntimeStorageRoot');
    expect(runtimeStateSource).toContain('getPackageLocalRuntimeContextCwd');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeInitialState',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'resolvePackageLocalRuntimeStorageRoot(options.options.storagePath)',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'getPackageLocalRuntimeContextCwd(options.defaultContext)',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.hookCallbacks = options.options.hooks ?? {}',
    );
    expect(existsSync('packages/agent-sdk/src/session/runtimeConnectionOperations.ts')).toBe(true);
    expect(runtimeConnectionOperationsSource).not.toContain('../../../../src/');
    expect(runtimeConnectionOperationsSource).toContain(
      'createPackageLocalRuntimeConnectionOperations',
    );
    expect(runtimeConnectionOperationsSource).toContain(
      'createPackageLocalRuntimeSessionOperations',
    );
    expect(runtimeConnectionOperationsSource).toContain(
      'createPackageLocalRuntimeMcpOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain(
      'createPackageLocalRuntimeConnectionOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeSessionOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeMcpOperations({',
    );
    expect(existsSync('packages/agent-sdk/src/session/runtimeContext.ts')).toBe(true);
    expect(runtimeContextSource).not.toContain('../../../../src/');
    expect(runtimeContextSource).toContain('resolvePackageLocalRuntimeStorageRoot');
    expect(runtimeContextSource).toContain('getPackageLocalRuntimeContextCwd');
    expect(packageLocalRuntimeInstanceSource).not.toContain('function getRuntimeContextCwd');
    expect(packageLocalRuntimeInstanceSource).toContain('isPackageLocalSdkMcpServerHandle');
    expect(existsSync('packages/agent-sdk/src/session/runtimeMcpServers.ts')).toBe(true);
    expect(runtimeMcpServersSource).not.toContain('../../../../src/');
    expect(runtimeMcpServersSource).toContain('isPackageLocalSdkMcpServerHandle');
    expect(runtimeMcpServersSource).toContain('callPackageLocalMcpRegistryAction');
    expect(runtimeMcpServersSource).toContain('registerPackageLocalInProcessMcpServer');
    expect(runtimeMcpServersSource).toContain('registerPackageLocalRemoteMcpServer');
    expect(runtimeMcpServersSource).toContain('registerPackageLocalConfiguredMcpServers');
    expect(runtimeMcpServersSource).toContain(
      'createPackageLocalRuntimeMcpServerConfigOperations',
    );
    expect(runtimeMcpServersSource).toContain(
      'createPackageLocalRuntimeMcpServerOperations',
    );
    expect(existsSync('packages/agent-sdk/src/session/runtimeMcp.ts')).toBe(true);
    expect(runtimeMcpSource).not.toContain('../../../../src/');
    expect(runtimeMcpSource).toContain('createPackageLocalRuntimeMcpOperations');
    expect(runtimeMcpSource).toContain('createPackageLocalRuntimeMcpCapabilityOperations');
    expect(runtimeMcpSource).toContain('createPackageLocalRuntimeMcpServerOperations');
    expect(runtimeMcpSource).toContain('createPackageLocalRuntimeMcpToolRefreshOperations');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'private readonly connectionOperations: PackageLocalRuntimeConnectionOperations<SessionMessage>',
    );
    expect(runtimeConnectionOperationsSource).toContain(
      'createPackageLocalRuntimeMcpOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeMcpOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('connectionOperations.mcp.capabilities');
    expect(packageLocalRuntimeInstanceSource).toContain('connectionOperations.mcp.servers');
    expect(packageLocalRuntimeInstanceSource).toContain('connectionOperations.mcp.tools');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly mcpOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('mcpCapabilityOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain('mcpServerConfigOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain('mcpServerRegistrationOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain('mcpServerLifecycleOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain('mcpToolRefreshOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeMcpCapabilityOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeMcpServerOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeMcpServerConfigOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.options.mcpServers ?? {}');
    expect(runtimeMcpServersSource).toContain(
      'createPackageLocalRuntimeMcpServerRegistrationOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeMcpServerRegistrationOperations({',
    );
    expect(runtimeMcpServersSource).toContain('ensurePackageLocalMcpServerRegistered');
    expect(runtimeMcpServersSource).toContain('closePackageLocalRuntimeMcpServers');
    expect(runtimeMcpServersSource).toContain('connectPackageLocalRuntimeMcpServer');
    expect(runtimeMcpServersSource).toContain('disconnectPackageLocalRuntimeMcpServer');
    expect(runtimeMcpServersSource).toContain('reconnectPackageLocalRuntimeMcpServer');
    expect(runtimeMcpServersSource).toContain(
      'createPackageLocalRuntimeMcpServerLifecycleOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('this.connectionOperations.mcp.servers.lifecycle');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeMcpServerLifecycleOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'connectPackageLocalRuntimeMcpServer({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'disconnectPackageLocalRuntimeMcpServer({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'reconnectPackageLocalRuntimeMcpServer({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'function isPackageLocalSdkMcpServerHandle',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('ensureSessionCreated');
    expect(packageLocalRuntimeInstanceSource).toContain('ensureSessionLoaded');
    expect(existsSync('packages/agent-sdk/src/session/runtimeSessionLifecycle.ts')).toBe(true);
    expect(runtimeSessionLifecycleSource).not.toContain('../../../../src/');
    expect(runtimeSessionLifecycleSource).toContain(
      'createPackageLocalRuntimeSessionLifecycleOperations',
    );
    expect(runtimeSessionLifecycleSource).toContain('runSessionStart(isResume)');
    expect(runtimeSessionLifecycleSource).toContain('closeRuntimeResources');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.hookRuntime.runSessionStart');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.hookRuntime.runSessionEnd');
    expect(existsSync('packages/agent-sdk/src/session/runtimeSessionOperations.ts')).toBe(true);
    expect(runtimeSessionOperationsSource).not.toContain('../../../../src/');
    expect(runtimeSessionOperationsSource).toContain(
      'createPackageLocalRuntimeSessionOperations',
    );
    expect(runtimeSessionOperationsSource).toContain(
      'createPackageLocalRuntimeSessionLifecycleOperations',
    );
    expect(runtimeSessionOperationsSource).toContain(
      'createPackageLocalRuntimeWorkspaceOperations',
    );
    expect(runtimeConnectionOperationsSource).toContain(
      'createPackageLocalRuntimeSessionOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeSessionOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('connectionOperations.session.lifecycle');
    expect(packageLocalRuntimeInstanceSource).toContain('connectionOperations.session.workspace');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly sessionOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('sessionLifecycleOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain('workspaceOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeSessionLifecycleOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeSessionStorePort');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'const loaded = await this.sessionStore.loadSession(this.sessionId)',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'return this.sessionStore.loadMessages(this.sessionId)',
    );
    expect(existsSync('packages/agent-sdk/src/session/runtimeForking.ts')).toBe(true);
    expect(runtimeForkingSource).not.toContain('../../../../src/');
    expect(runtimeForkingSource).toContain('forkPackageLocalRuntimeSession');
    expect(runtimeForkingSource).toContain('createPackageLocalRuntimeForkOperations');
    expect(existsSync('packages/agent-sdk/src/session/runtimeSessionCapabilities.ts')).toBe(true);
    expect(runtimeSessionCapabilitiesSource).not.toContain('../../../../src/');
    expect(runtimeSessionCapabilitiesSource).toContain(
      'createPackageLocalRuntimeSessionCapabilityOperations',
    );
    expect(runtimeSessionCapabilitiesSource).toContain(
      'createPackageLocalRuntimeSubagentOperations',
    );
    expect(runtimeSessionCapabilitiesSource).toContain('createPackageLocalRuntimeForkOperations');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'createPackageLocalRuntimeSessionCapabilityOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain(
      'private readonly sessionCapabilityOperations: PackageLocalRuntimeSessionCapabilityOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('sessionCapabilityOperations.subagents');
    expect(packageLocalRuntimeInstanceSource).toContain('sessionCapabilityOperations.fork');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly subagentOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('private readonly forkOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeForkOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'forkPackageLocalRuntimeSession({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.sessionStore.forkState(this.sessionId, options)',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.sessionStore.writeForkState(forkedSessionId, snapshot)',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.createForkSessionId()');
    expect(packageLocalRuntimeInstanceSource).toContain('prepareTurn');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeWorkspacePort');
    expect(existsSync('packages/agent-sdk/src/session/runtimeWorkspace.ts')).toBe(true);
    expect(runtimeWorkspaceSource).not.toContain('../../../../src/');
    expect(runtimeWorkspaceSource).toContain('preparePackageLocalRuntimeWorkspaceTurn');
    expect(runtimeWorkspaceSource).toContain(
      'createPackageLocalRuntimeWorkspaceOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain(
      'this.connectionOperations.session.workspace.prepareTurn',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeWorkspaceOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'preparePackageLocalRuntimeWorkspaceTurn({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.workspace.updateWorkspace({');
    expect(packageLocalRuntimeInstanceSource).not.toContain('...snapshot.environment');
    expect(packageLocalRuntimeInstanceSource).toContain('close');
    expect(runtimePortsSource).toContain('PackageLocalRuntimeMcpRegistryPort');
    expect(runtimeMcpServersSource).toContain('closePackageLocalRuntimeMcpServers');
    expect(packageLocalRuntimeInstanceSource).not.toContain('closePackageLocalRuntimeMcpServers({');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.mcpRegistry.disconnectAll()');
    expect(packageLocalRuntimeInstanceSource).toContain('mcpCapabilities');
    expect(packageLocalRuntimeInstanceSource).toContain('mcpServerStatus');
    expect(packageLocalRuntimeInstanceSource).toContain('mcpListTools');
    expect(packageLocalRuntimeInstanceSource).toContain('mcpConnect');
    expect(packageLocalRuntimeInstanceSource).toContain('mcpDisconnect');
    expect(packageLocalRuntimeInstanceSource).toContain('mcpReconnect');
    expect(runtimePortsSource).toContain('ensureServerRegistered');
    expect(packageLocalRuntimeInstanceSource).not.toContain('ensurePackageLocalMcpServerRegistered');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      "callPackageLocalMcpRegistryAction(this.mcpRegistry, 'connectServer', serverName)",
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      "callPackageLocalMcpRegistryAction(this.mcpRegistry, 'disconnectServer', serverName)",
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      "callPackageLocalMcpRegistryAction(this.mcpRegistry, 'reconnectServer', serverName)",
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('private async ensureMcpServerRegistered');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeMcpServerCapability');
    expect(existsSync('packages/agent-sdk/src/session/runtimeMcpCapabilities.ts')).toBe(true);
    expect(runtimeMcpCapabilitiesSource).not.toContain('../../../../src/');
    expect(runtimeMcpCapabilitiesSource).toContain(
      'projectPackageLocalRuntimeMcpServerStatus',
    );
    expect(runtimeMcpCapabilitiesSource).toContain('listPackageLocalRuntimeMcpTools');
    expect(runtimeMcpCapabilitiesSource).toContain(
      'createPackageLocalRuntimeMcpCapabilityOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('connectionOperations.mcp.capabilities');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeMcpCapabilityOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'projectPackageLocalRuntimeMcpServerStatus',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('listPackageLocalRuntimeMcpTools');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'return this.mcpRegistry.getCapabilities()',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'projectPackageLocalRuntimeMcpServerStatus(await this.mcpCapabilities())',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'listPackageLocalRuntimeMcpTools(await this.mcpCapabilities())',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'capability.tools.map((tool) => tool.name)',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('.flatMap((capability)');
    expect(packageLocalRuntimeInstanceSource).toContain('filterTools');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeNamedTool');
    expect(existsSync('packages/agent-sdk/src/session/runtimeToolFilters.ts')).toBe(true);
    expect(runtimeToolFiltersSource).not.toContain('../../../../src/');
    expect(runtimeToolFiltersSource).toContain('filterPackageLocalRuntimeTools');
    expect(runtimeToolFiltersSource).toContain(
      'createPackageLocalRuntimeToolFilterOperations',
    );
    expect(existsSync('packages/agent-sdk/src/session/runtimeTools.ts')).toBe(true);
    expect(runtimeToolsSource).not.toContain('../../../../src/');
    expect(runtimeToolsSource).toContain('createPackageLocalRuntimeToolOperations');
    expect(runtimeToolsSource).toContain('createPackageLocalRuntimeToolFilterOperations');
    expect(runtimeToolsSource).toContain('createPackageLocalRuntimeToolRegistrationOperations');
    expect(runtimeToolsSource).toContain(
      'createPackageLocalRuntimeSessionToolRegistrationOperations',
    );
    expect(runtimeToolFiltersSource).toContain('allowedTools !== undefined');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'private readonly toolOperations: PackageLocalRuntimeToolOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain(
      'createPackageLocalRuntimeToolOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeToolFilterOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'filterPackageLocalRuntimeTools(tools, {',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('allowedTools !== undefined');
    expect(packageLocalRuntimeInstanceSource).toContain('registerTools');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeToolCatalogPort');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeToolSource');
    expect(packageLocalRuntimeInstanceSource).toContain('registerConfiguredMcpServers');
    expect(runtimePortsSource).toContain('registerInProcessServer');
    expect(runtimePortsSource).toContain('registerServer');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'registerPackageLocalConfiguredMcpServers({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('private async callMcpRegistryMethod');
    expect(packageLocalRuntimeInstanceSource).not.toContain('private async registerInProcessMcpServer');
    expect(packageLocalRuntimeInstanceSource).not.toContain('private async registerRemoteMcpServer');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeLoggerPort');
    expect(packageLocalRuntimeInstanceSource).toContain('refreshMcpTools');
    expect(packageLocalRuntimeInstanceSource).toContain('this.connectionOperations.mcp.servers.registration');
    expect(packageLocalRuntimeInstanceSource).not.toContain('Object.entries(configuredServers)');
    expect(packageLocalRuntimeInstanceSource).not.toContain('if (config.disabled)');
    expect(runtimePortsSource).toContain('getAvailableToolsByServerNames');
    expect(runtimePortsSource).toContain('registerMcpTool');
    expect(runtimePortsSource).toContain('removeMcpTools');
    expect(existsSync('packages/agent-sdk/src/session/runtimeMcpTools.ts')).toBe(true);
    expect(runtimeMcpToolsSource).not.toContain('../../../../src/');
    expect(runtimeMcpToolsSource).toContain('getPackageLocalMcpToolSourceId');
    expect(runtimeMcpToolsSource).toContain('refreshPackageLocalRuntimeMcpTools');
    expect(runtimeMcpToolsSource).toContain('createPackageLocalRuntimeMcpToolRefreshOperations');
    expect(packageLocalRuntimeInstanceSource).toContain('this.connectionOperations.mcp.tools');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeMcpToolRefreshOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('getPackageLocalMcpToolSourceId');
    expect(packageLocalRuntimeInstanceSource).not.toContain('refreshPackageLocalRuntimeMcpTools({');
    expect(packageLocalRuntimeInstanceSource).not.toContain('removeMcpTools(serverName);');
    expect(packageLocalRuntimeInstanceSource).not.toContain('registerMcpTool(tool,');
    expect(packageLocalRuntimeInstanceSource).not.toContain('function packageLocalServerNameFromTool');
    expect(existsSync('packages/agent-sdk/src/session/runtimeToolRegistration.ts')).toBe(true);
    expect(runtimeToolRegistrationSource).not.toContain('../../../../src/');
    expect(runtimeToolRegistrationSource).toContain('registerPackageLocalRuntimeCustomTools');
    expect(runtimeToolRegistrationSource).toContain('registerPackageLocalRuntimeBuiltinTools');
    expect(runtimeToolRegistrationSource).toContain(
      'createPackageLocalRuntimeToolRegistrationOperations',
    );
    expect(runtimeToolRegistrationSource).toContain(
      'createPackageLocalRuntimeSessionToolRegistrationOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeToolRegistrationOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeSessionToolRegistrationOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('toolOperations.registration');
    expect(packageLocalRuntimeInstanceSource).toContain('toolOperations.sessionRegistration');
    expect(packageLocalRuntimeInstanceSource).toContain('toolOperations.filter');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly toolRegistrationOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly sessionToolRegistrationOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly toolFilterOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'registerPackageLocalRuntimeCustomTools({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'registerPackageLocalRuntimeBuiltinTools({',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('registerCustomTools');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeCustomToolFactoryPort');
    expect(packageLocalRuntimeInstanceSource).not.toContain('filteredTools.length === 0');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.toolCatalog.registerAll');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      "throw new Error('Package-local custom tool factory port is required to register tools')",
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'definitions.map((definition) => customToolFactory.fromDefinition(definition))',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('registerBuiltinTools');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeBuiltinToolProviderPort');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeBuiltinToolContext');
    expect(packageLocalRuntimeInstanceSource).not.toContain('includeMcpProtocolTools: false');
    expect(packageLocalRuntimeInstanceSource).not.toContain('builtinToolProvider?.getTools');
    expect(packageLocalRuntimeInstanceSource).toContain('initializeSubagents');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeSubagentRegistryPort');
    expect(existsSync('packages/agent-sdk/src/session/runtimeSubagents.ts')).toBe(true);
    expect(runtimeSubagentsSource).not.toContain('../../../../src/');
    expect(runtimeSubagentsSource).toContain('packageLocalSubagentConfigFromDefinition');
    expect(runtimeSubagentsSource).toContain('initializePackageLocalRuntimeSubagents');
    expect(runtimeSubagentsSource).toContain('createPackageLocalRuntimeSubagentOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain('packageLocalSubagentConfigFromDefinition');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeSubagentOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('sessionCapabilityOperations.subagents');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'initializePackageLocalRuntimeSubagents({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'function packageLocalSubagentConfigFromDefinition',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.subagentRegistry.setLogger(this.logger)',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'Object.entries(this.options.agents ?? {})',
    );
    expect(existsSync('packages/agent-sdk/src/session/runtimeCapabilities.ts')).toBe(true);
    expect(runtimeCapabilitiesSource).not.toContain('../../../../src/');
    expect(runtimeCapabilitiesSource).toContain(
      'createPackageLocalRuntimeCapabilityInitializationOperations',
    );
    expect(runtimeCapabilitiesSource).toContain(
      'createPackageLocalRuntimeCapabilityStartupOperations',
    );
    expect(runtimeCapabilitiesSource).toContain(
      'createPackageLocalRuntimeCapabilityOperations',
    );
    expect(runtimeCapabilitiesSource).toContain(
      'runtimeCapabilitiesInitialization',
    );
    expect(runtimeCapabilitiesSource).toContain('subagentLocationsNeedRefresh');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'createPackageLocalRuntimeCapabilityOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain(
      'private readonly capabilityOperations: PackageLocalRuntimeCapabilityOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('capabilityOperations.initialization');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly capabilityInitializationOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('capabilityStartupOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeCapabilityInitializationOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeCapabilityStartupOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private async initializeRuntimeCapabilities',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private runtimeCapabilitiesInitialization',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private runtimeCapabilitiesInitialized',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private subagentLocationsNeedRefresh',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.runtimeCapabilitiesInitialization ??=',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.subagentLocationsNeedRefresh = true',
    );
    expect(existsSync('packages/agent-sdk/src/session/runtimeControls.ts')).toBe(true);
    expect(runtimeControlsSource).not.toContain('../../../../src/');
    expect(runtimeControlsSource).toContain('createPackageLocalRuntimeControlOperations');
    expect(runtimeControlsSource).toContain('buildSessionModelConfig');
    expect(runtimeControlsSource).toContain('getPackageLocalRuntimeContextCwd');
    expect(packageLocalRuntimeInstanceSource).toContain('controlOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain('buildSessionModelConfig');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.bladeConfig.models = [modelConfig]',
    );
    expect(runtimeControlsSource).toContain('options.resetExecutionPipeline();');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'resetExecutionPipeline: () => this.executionOperations.pipeline.reset()',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.options.maxTurns = maxTurns',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('createPermissionHandler');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimePermissionHookPort');
    expect(existsSync('packages/agent-sdk/src/session/runtimePermissions.ts')).toBe(true);
    expect(runtimePermissionsSource).not.toContain('../../../../src/');
    expect(runtimePermissionsSource).toContain('createPackageLocalRuntimePermissionHandler');
    expect(runtimePermissionsSource).toContain('createPackageLocalRuntimePermissionOperations');
    expect(runtimePermissionsSource).toContain('createPermissionHandlerFromCanUseTool');
    expect(runtimePermissionsSource).toContain('createCompositePermissionHandler');
    expect(existsSync('packages/agent-sdk/src/session/runtimeGuards.ts')).toBe(true);
    expect(runtimeGuardsSource).not.toContain('../../../../src/');
    expect(runtimeGuardsSource).toContain('createPackageLocalRuntimeGuardOperations');
    expect(runtimeGuardsSource).toContain('createPackageLocalRuntimePermissionOperations');
    expect(runtimeGuardsSource).toContain('createPackageLocalRuntimeHookOperations');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'createPackageLocalRuntimeGuardOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('guardOperations.permissions');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'private readonly guardOperations: PackageLocalRuntimeGuardOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly permissionOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly hookOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimePermissionHandler({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimePermissionOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('HookEvent.PermissionRequest');
    expect(packageLocalRuntimeInstanceSource).not.toContain('createPermissionHandlerFromCanUseTool');
    expect(packageLocalRuntimeInstanceSource).not.toContain('createCompositePermissionHandler');
    expect(packageLocalRuntimeInstanceSource).toContain('initializeHooks');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeHookManagerPort');
    expect(existsSync('packages/agent-sdk/src/session/runtimeHooks.ts')).toBe(true);
    expect(runtimeHooksSource).not.toContain('../../../../src/');
    expect(runtimeHooksSource).toContain('initializePackageLocalRuntimeHooks');
    expect(runtimeHooksSource).toContain('createPackageLocalRuntimeHookOperations');
    expect(runtimeHooksSource).toContain('streamWithPackageLocalRuntimeTraceCollector');
    expect(packageLocalRuntimeInstanceSource).toContain('guardOperations.hooks');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeHookOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('initializePackageLocalRuntimeHooks({');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.hookManager.enable()');
    expect(packageLocalRuntimeInstanceSource).not.toContain('Object.keys(this.options.hooks');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.hookRuntime.setTraceCollector');
    expect(existsSync('packages/agent-sdk/src/session/runtimeTraceManager.ts')).toBe(true);
    expect(runtimeTraceManagerSource).not.toContain('../../../../src/');
    expect(runtimeTraceManagerSource).toContain('createPackageLocalRuntimeTraceManager');
    expect(runtimeTraceManagerSource).toContain('createPackageLocalRuntimeTraceOperations');
    expect(runtimeTraceManagerSource).toContain('createPackageLocalRuntimeTraceRuntime');
    expect(runtimeTraceManagerSource).toContain('new SessionTraceManager({');
    expect(existsSync('packages/agent-sdk/src/session/runtimeTurn.ts')).toBe(true);
    expect(runtimeTurnSource).not.toContain('../../../../src/');
    expect(runtimeTurnSource).toContain('createPackageLocalRuntimeTurnOperations');
    expect(runtimeTurnSource).toContain('createPackageLocalRuntimeTraceRuntime');
    expect(runtimeTurnSource).toContain('createPackageLocalRuntimeKernelTurnStreamOperations');
    expect(packageLocalRuntimeInstanceSource).toContain('createPackageLocalRuntimeTurnOperations');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'private readonly turnOperations: PackageLocalRuntimeTurnOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('turnOperations.kernelTurnStream');
    expect(packageLocalRuntimeInstanceSource).toContain('turnOperations.traceOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly traceManager',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly traceOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'private readonly kernelTurnStreamOperations',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeTraceRuntime({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeTraceManager({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeTraceOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('new SessionTraceManager({');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.traceManager.getLastTrace()');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.traceManager.getTraces()');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'permissionMode: options.options.permissionMode ?? PermissionMode.DEFAULT',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('Observability trace sink failed');
    expect(packageLocalRuntimeInstanceSource).toContain('createExecutionPipeline');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'PackageLocalRuntimeExecutionPipelineFactoryPort',
    );
    expect(existsSync('packages/agent-sdk/src/session/runtimeExecutionPipeline.ts')).toBe(true);
    expect(runtimeExecutionPipelineSource).not.toContain('../../../../src/');
    expect(runtimeExecutionPipelineSource).toContain('createPackageLocalRuntimeExecutionPipeline');
    expect(runtimeExecutionPipelineSource).toContain(
      'createPackageLocalRuntimeExecutionPipelineCache',
    );
    expect(runtimeExecutionPipelineSource).toContain(
      'createPackageLocalRuntimeExecutionPipelineOperations',
    );
    expect(existsSync('packages/agent-sdk/src/session/runtimeExecution.ts')).toBe(true);
    expect(runtimeExecutionSource).not.toContain('../../../../src/');
    expect(runtimeExecutionSource).toContain('createPackageLocalRuntimeExecutionOperations');
    expect(runtimeExecutionSource).toContain(
      'createPackageLocalRuntimeExecutionPipelineOperations',
    );
    expect(runtimeExecutionSource).toContain('createPackageLocalAgentRuntimeDepsOperations');
    expect(existsSync('packages/agent-sdk/src/session/runtimeToolExecution.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/__tests__/runtimeToolExecution.test.ts')).toBe(true);
    expect(existsSync('src/agent/loop/__tests__/executeToolCalls.test.ts')).toBe(false);
    expect(runtimeToolExecutionSource).not.toContain('../../../../src/');
    expect(runtimeToolExecutionSource).toContain('executePackageLocalToolCalls');
    expect(runtimeToolExecutionSource).toContain('runPackageLocalToolCall');
    expect(rootRunToolCallSource).toContain('runPackageLocalToolCall');
    expect(rootRunToolCallSource).not.toContain('emitPackageLocalToolExecutionUpdate');
    expect(rootRunToolCallSource).not.toContain('hooks?.onUpdate?.(update)');
    expect(rootRunToolCallSource).not.toContain('repairToolCallParams');
    expect(rootRunToolCallSource).not.toContain('normalizeToolEffects');
    expect(rootRunToolCallSource).not.toContain('createInterruptAwareAbortSignal');
    expect(existsSync('packages/agent-sdk/src/session/runtimeRunTurn.ts')).toBe(true);
    expect(runtimeRunTurnSource).not.toContain('../../../src/');
    expect(runtimeRunTurnSource).toContain('runPackageLocalTurn');
    expect(runtimeRunTurnSource).toContain('PackageLocalStreamingToolExecutor');
    expect(runtimeRunTurnSource).toContain('streamPackageLocalChatResponse');
    expect(runtimeRunTurnSource).toContain('toolUpdateToAgentEvent');
    expect(rootRunTurnSource).toContain('runPackageLocalTurn');
    expect(rootRunTurnSource).not.toContain('runStreamingWithTools');
    expect(rootRunTurnSource).not.toContain('new AsyncEventQueue');
    expect(rootRunTurnSource).not.toContain('new StreamingToolExecutor');
    expect(rootRunTurnSource).not.toContain('chatWithRetryEvents');
    expect(existsSync('packages/agent-sdk/src/session/streamingToolExecutor.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/__tests__/streamingToolExecutor.test.ts')).toBe(
      true,
    );
    expect(existsSync('src/agent/StreamingToolExecutor.ts')).toBe(false);
    expect(existsSync('src/agent/__tests__/StreamingToolExecutor.test.ts')).toBe(false);
    expect(streamingToolExecutorSource).not.toContain('../../../src/');
    expect(streamingToolExecutorSource).toContain('PackageLocalStreamingToolExecutor');
    expect(streamingToolExecutorSource).toContain('runPackageLocalToolCall');
    expect(existsSync('packages/agent-sdk/src/session/streamChatResponse.ts')).toBe(true);
    expect(existsSync('packages/agent-sdk/src/__tests__/streamChatResponse.test.ts')).toBe(true);
    expect(existsSync('src/agent/loop/streamChatResponse.ts')).toBe(false);
    expect(existsSync('src/agent/loop/__tests__/streamChatResponse.test.ts')).toBe(false);
    expect(streamChatResponseSource).not.toContain('../../../src/');
    expect(streamChatResponseSource).toContain('streamPackageLocalChatResponse');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'createPackageLocalRuntimeExecutionOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain(
      'private readonly executionOperations: PackageLocalRuntimeExecutionOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('executionOperations.pipeline');
    expect(packageLocalRuntimeInstanceSource).toContain('executionOperations.agentDeps');
    expect(packageLocalRuntimeInstanceSource).not.toContain('executionPipelineOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain('agentRuntimeDepsOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeExecutionPipelineOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeExecutionPipeline({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeExecutionPipelineCache',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('private executionPipelineCreated');
    expect(packageLocalRuntimeInstanceSource).not.toContain('private executionPipeline: unknown');
    expect(packageLocalRuntimeInstanceSource).not.toContain('allow: []');
    expect(packageLocalRuntimeInstanceSource).not.toContain('maxHistorySize: 1000');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.executionPipelineFactory.create({',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('getAgentRuntimeDeps');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalAgentRuntimeDeps');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeBackgroundAgentManagerPort');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeHookRuntimePort');
    expect(existsSync('packages/agent-sdk/src/session/runtimeAgentDeps.ts')).toBe(true);
    expect(runtimeAgentDepsSource).not.toContain('../../../../src/');
    expect(runtimeAgentDepsSource).toContain('createPackageLocalAgentRuntimeDeps');
    expect(runtimeAgentDepsSource).toContain('createPackageLocalAgentRuntimeDepsOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalAgentRuntimeDepsOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('createPackageLocalAgentRuntimeDeps({');
    expect(packageLocalRuntimeInstanceSource).not.toContain('runtimeManaged: true');
    expect(packageLocalRuntimeInstanceSource).toContain('getKernelToolPort');
    expect(packageLocalRuntimeInstanceSource).toContain('getKernelStorePort');
    expect(packageLocalRuntimeInstanceSource).toContain('getKernelTracePort');
    expect(packageLocalRuntimeInstanceSource).toContain('getKernelHookPort');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeKernelPortFactoryPort');
    expect(existsSync('packages/agent-sdk/src/session/runtimeKernelPorts.ts')).toBe(true);
    expect(runtimeKernelPortsSource).not.toContain('../../../../src/');
    expect(runtimeKernelPortsSource).toContain('createPackageLocalRuntimeKernelToolPort');
    expect(runtimeKernelPortsSource).toContain('createPackageLocalRuntimeKernelStorePort');
    expect(runtimeKernelPortsSource).toContain('createPackageLocalRuntimeKernelTracePort');
    expect(runtimeKernelPortsSource).toContain('createPackageLocalRuntimeKernelHookPort');
    expect(runtimeKernelPortsSource).toContain('createPackageLocalRuntimeKernelPortOperations');
    expect(existsSync('packages/agent-sdk/src/session/runtimeKernel.ts')).toBe(true);
    expect(runtimeKernelSource).not.toContain('../../../../src/');
    expect(runtimeKernelSource).toContain('createPackageLocalRuntimeKernelOperations');
    expect(runtimeKernelSource).toContain('createPackageLocalRuntimeKernelPortOperations');
    expect(runtimeKernelSource).toContain('createPackageLocalRuntimeAgentKernelOperations');
    expect(packageLocalRuntimeInstanceSource).toContain(
      'createPackageLocalRuntimeKernelOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain(
      'private readonly kernelOperations: PackageLocalRuntimeKernelOperations',
    );
    expect(packageLocalRuntimeInstanceSource).toContain('kernelOperations.ports');
    expect(packageLocalRuntimeInstanceSource).toContain('kernelOperations.agentKernel');
    expect(packageLocalRuntimeInstanceSource).not.toContain('kernelPortOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeKernelPortOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeKernelToolPort',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeKernelStorePort',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeKernelTracePort',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeKernelHookPort',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.kernelPortFactory.createToolPort({');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.kernelPortFactory.createStorePort({');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.kernelPortFactory.createTracePort({');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.kernelPortFactory.createHookPort({');
    expect(packageLocalRuntimeInstanceSource).toContain('createAgentKernel');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeAgentKernelFactoryPort');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeKernelModelResolverPort');
    expect(existsSync('packages/agent-sdk/src/session/runtimeAgentKernels.ts')).toBe(true);
    expect(runtimeAgentKernelsSource).not.toContain('../../../../src/');
    expect(runtimeAgentKernelsSource).toContain('createPackageLocalRuntimeAgentKernel');
    expect(runtimeAgentKernelsSource).toContain('projectPackageLocalRuntimeAgentKernelPorts');
    expect(runtimeAgentKernelsSource).toContain(
      'createPackageLocalRuntimeAgentKernelFromResolved',
    );
    expect(runtimeAgentKernelsSource).toContain(
      'createPackageLocalRuntimeAgentKernelFromOptions',
    );
    expect(runtimeAgentKernelsSource).toContain(
      'createPackageLocalRuntimeResolvedAgentKernelCreator',
    );
    expect(runtimeAgentKernelsSource).toContain(
      'createPackageLocalRuntimeAgentKernelOperations',
    );
    expect(runtimeAgentKernelsSource).toContain('resolvePackageLocalRuntimeKernelModel');
    expect(packageLocalRuntimeInstanceSource).not.toContain('agentKernelOperations');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeAgentKernelOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeAgentKernelFromOptions',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeResolvedAgentKernelCreator',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('private createAgentKernelFromResolved');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeAgentKernelFromResolved',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('resolvePackageLocalRuntimeKernelModel');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'projectPackageLocalRuntimeAgentKernelPorts',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeAgentKernel({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('store: this.getKernelStorePort()');
    expect(packageLocalRuntimeInstanceSource).not.toContain('hooks: this.getKernelHookPort()');
    expect(packageLocalRuntimeInstanceSource).not.toContain('trace: this.getKernelTracePort');
    expect(packageLocalRuntimeInstanceSource).not.toContain('tools: this.getKernelToolPort');
    expect(packageLocalRuntimeInstanceSource).not.toContain('this.kernelFactory.create({');
    expect(packageLocalRuntimeInstanceSource).not.toContain('? { modelRequestDefaults:');
    expect(existsSync('packages/agent-sdk/src/session/runtimeKernelModels.ts')).toBe(true);
    expect(runtimeKernelModelsSource).not.toContain('../../../../src/');
    expect(runtimeKernelModelsSource).toContain('resolvePackageLocalRuntimeKernelModel');
    expect(packageLocalRuntimeInstanceSource).not.toContain('resolvePackageLocalRuntimeKernelModel');
    expect(packageLocalRuntimeInstanceSource).not.toContain('private resolveAgentKernelModel');
    expect(packageLocalRuntimeInstanceSource).toContain('streamAgentKernelTurn');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeAgentKernelPort');
    expect(packageLocalRuntimeInstanceSource).toContain('PackageLocalRuntimeAgentKernelStreamOptions');
    expect(existsSync('packages/agent-sdk/src/session/runtimeKernelTraceFinalization.ts')).toBe(
      true,
    );
    expect(runtimeKernelTraceFinalizationSource).not.toContain('../../../../src/');
    expect(runtimeKernelTraceFinalizationSource).toContain(
      'updatePackageLocalKernelTraceFinalization',
    );
    expect(runtimeKernelTraceFinalizationSource).toContain('finishPackageLocalKernelTraceError');
    expect(runtimeKernelTurnStreamSource).toContain(
      'updatePackageLocalKernelTraceFinalization',
    );
    expect(runtimeKernelTurnStreamSource).toContain('finishPackageLocalKernelTraceError');
    expect(packageLocalRuntimeInstanceSource).not.toContain("event.type === 'usage'");
    expect(packageLocalRuntimeInstanceSource).not.toContain("traceFinalizer.finish('success'");
    expect(packageLocalRuntimeInstanceSource).not.toContain("traceFinalizer.finish('error'");
    expect(existsSync('packages/agent-sdk/src/session/runtimeKernelTurnStream.ts')).toBe(true);
    expect(runtimeKernelTurnStreamSource).not.toContain('../../../../src/');
    expect(runtimeKernelTurnStreamSource).toContain('streamPackageLocalAgentKernelTurn');
    expect(runtimeKernelTurnStreamSource).toContain('streamPackageLocalRuntimeAgentKernelTurn');
    expect(runtimeKernelTurnStreamSource).toContain(
      'createPackageLocalRuntimeKernelTurnStreamOperations',
    );
    expect(runtimeKernelTurnStreamSource).toContain('resolvePackageLocalRuntimeKernelModel');
    expect(runtimeKernelTurnStreamSource).toContain('PackageLocalRuntimeAgentKernelStreamOptions');
    expect(runtimeKernelTurnStreamSource).toContain('streamWithPackageLocalRuntimeTraceCollector');
    expect(runtimeKernelTurnStreamSource).toContain('projectPackageLocalKernelEventToStreamMessages');
    expect(packageLocalRuntimeInstanceSource).toContain('turnOperations.kernelTurnStream');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'createPackageLocalRuntimeKernelTurnStreamOperations({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'streamPackageLocalRuntimeAgentKernelTurn({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'this.traceManager.createRecorder(options.input)',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('const kernel =');
    expect(packageLocalRuntimeInstanceSource).not.toContain('const maxContextTokens =');
    expect(packageLocalRuntimeInstanceSource).not.toContain('kernel.runTurn({');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'streamWithPackageLocalRuntimeTraceCollector({',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'projectPackageLocalKernelEventToStreamMessages(event',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('createSessionTraceFinalizer');
    expect(kernelStreamBridgeSource).not.toContain("from './runtimeInstance.js'");
    expect(packageLocalRuntimeInstanceSource).toContain(
      'PackageLocalRuntimeKernelStreamProjectionOptions',
    );
    expect(packageLocalRuntimeInstanceSource).not.toContain('toPackageLocalSessionUsage');
    expect(packageLocalRuntimeInstanceSource).not.toContain(
      'toPackageLocalSessionPermissionUpdates',
    );
    expect(existsSync('packages/agent-sdk/src/session/packageLocalKernelRuntimeFactory.ts')).toBe(
      true,
    );
    expect(packageLocalKernelRuntimeFactorySource).not.toContain('../../../../src/');
    expect(packageLocalKernelRuntimeFactorySource).toContain(
      'createPackageLocalKernelSessionRuntimeFactory',
    );
    expect(packageLocalKernelRuntimeFactorySource).toContain('createPackageLocalSessionRuntimeFactory');
    expect(packageLocalKernelRuntimeFactorySource).toContain('createKernelStreamTurnBridge');
    expect(existsSync('packages/agent-sdk/src/session/defaultKernelRuntimeFactory.ts')).toBe(
      true,
    );
    expect(defaultKernelRuntimeFactorySource).not.toContain('../../../../src/');
    expect(defaultKernelRuntimeFactorySource).toContain('createDefaultKernelSessionRuntimeFactory');
    expect(defaultKernelRuntimeFactorySource).toContain('createPackageLocalKernelSessionRuntimeFactory');
    expect(defaultKernelRuntimeFactorySource).toContain('PackageLocalSessionRuntime');
    expect(defaultKernelRuntimeFactorySource).toContain('buildBladeConfig');
    expect(defaultKernelRuntimeFactorySource).toContain('createPackageLocalKernelModelResolver');
    expect(defaultKernelRuntimeFactorySource).toContain('createPackageLocalAgentKernelFactory');
    expect(existsSync('packages/agent-sdk/src/session/kernelModelResolver.ts')).toBe(true);
    expect(kernelModelResolverSource).not.toContain('../../../../src/');
    expect(kernelModelResolverSource).toContain('createPackageLocalKernelModelResolver');
    expect(kernelModelResolverSource).toContain('@blade-ai/ai/providers/vercel');
    expect(kernelModelResolverSource).toContain('PackageLocalRuntimeKernelModelResolverPort');
    expect(existsSync('packages/agent-sdk/src/session/kernelFactory.ts')).toBe(true);
    expect(kernelFactorySource).not.toContain('../../../../src/');
    expect(kernelFactorySource).toContain('createPackageLocalAgentKernelFactory');
    expect(kernelFactorySource).toContain("from '@blade-ai/agent/kernel'");
    expect(kernelFactorySource).toContain('AgentKernel');
    expect(kernelFactorySource).toContain('PackageLocalRuntimeAgentKernelFactoryPort');
    expect(kernelFactorySource).toContain("from './runtimeAgentKernels.js'");
    expect(kernelFactorySource).not.toContain("from './runtimeInstance.js'");
    expect(sessionRuntimeFactorySource).not.toContain('../../../../src/session/Session.js');
    expect(sessionRuntimeFactorySource).toContain('interface DefaultSessionRuntimeFactoryOptions');
    expect(sessionRuntimeFactorySource).toContain('loadKernelRuntimeFactory');
    expect(sessionRuntimeFactorySource).toContain('createDefaultKernelSessionRuntimeFactory');
    expect(sessionRuntimeFactorySource).not.toContain('loadLegacyRuntimeFactory');
    expect(sessionRuntimeFactorySource).not.toContain('loadDefaultLegacyRuntimeFactory');
    expect(sessionRuntimeFactorySource).toContain("from './Session.js'");
    expect(sessionRuntimeFactorySource).not.toContain('legacySessionAdapter');
    expect(sessionFactorySource).not.toContain('fork(options');
    expect(sessionFactorySource).not.toContain('prompt(message');
    expect(sessionRuntimeFactorySource).not.toContain('forkSession');
    expect(sessionRuntimeFactorySource).not.toContain('prompt');
    expect(sessionSource).toContain('createSession as runCreateLifecycle');
    expect(sessionSource).toContain('resumeSession as runResumeLifecycle');
    expect(sessionSource).not.toContain('return sessionRuntimeFactory.create(options)');
    expect(sessionSource).not.toContain('return sessionRuntimeFactory.resume(options)');
    expect(sessionSource).not.toContain('resumeSession() requires session persistence');
    expect(sessionSource).not.toContain('forkSession() requires session persistence');
    expect(sessionLifecycleSource).toContain('resumeSession() requires session persistence');
    expect(sessionLifecycleSource).toContain('forkSession() requires session persistence');
    expect(sessionLifecycleSource).toContain('new PromptStreamAccumulator()');
    expect(sessionLifecycleSource).toContain('closeSessionAfterLifecycle');
    expect(sessionLifecycleSource).not.toContain('../../../../src/session/Session.js');
    expect(sessionConfigSource).not.toContain('../../../../src/session/Session');
    expect(sessionConfigSource).not.toContain('../../../../src/types/common');
    expect(sessionStoreSource).not.toContain('../../../../src/session/SessionStore');
    expect(sessionStoreSource).not.toContain('../../../../src/context/storage');
    expect(sessionSource).toContain("from './types.js'");
    expect(sessionSource).toContain('createDefaultSessionRuntimeFactory');
    expect(sessionTypesSource).toContain("from '@blade-ai/agent/budget'");
    expect(sessionTypesSource).not.toContain("from '@blade-ai/agent';");
    expect(sessionTypesSource).not.toContain('AgentTokenBudgetSnapshot');
  });

  it('resolves workspace packages from source during type checking', () => {
    const agentTsconfig = readJson('packages/agent/tsconfig.json');
    const sdkTsconfig = readJson('packages/agent-sdk/tsconfig.json');

    expect(agentTsconfig.compilerOptions?.paths).toMatchObject({
      '@blade-ai/ai': ['../ai/src/index.ts'],
    });
    expect(sdkTsconfig.compilerOptions?.paths).toMatchObject({
      '@blade-ai/agent': ['../agent/src/index.ts'],
      '@blade-ai/agent/budget': ['../agent/src/budget/TokenBudget.ts'],
      '@blade-ai/agent/epoch': ['../agent/src/epoch/ExecutionEpoch.ts'],
      '@blade-ai/agent/kernel': ['../agent/src/kernel/AgentKernel.ts'],
      '@blade-ai/agent/loop': ['../agent/src/loop/index.ts'],
      '@blade-ai/agent/ports': ['../agent/src/ports/index.ts'],
      '@blade-ai/agent/protocol': ['../agent/src/protocol/index.ts'],
      '@blade-ai/agent/state': ['../agent/src/state/index.ts'],
      '@blade-ai/agent/tracing': ['../agent/src/tracing/index.ts'],
      '@blade-ai/ai': ['../ai/src/index.ts'],
    });
    expect(sdkTsconfig.compilerOptions?.paths).not.toHaveProperty('@/*');
    expect(sdkTsconfig.include).toEqual(['src/**/*']);
  });

  it('excludes test declarations from package build output', () => {
    for (const dir of ['packages/ai', 'packages/agent', 'packages/agent-sdk']) {
      const buildConfig = readJson(join(dir, 'tsconfig.build.json'));

      expect(buildConfig.exclude).toEqual(
        expect.arrayContaining(['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**']),
      );
    }
  });

  it('does not emit declaration maps from publishable package builds', () => {
    for (const dir of ['packages/ai', 'packages/agent', 'packages/agent-sdk']) {
      const buildConfig = readJson(join(dir, 'tsconfig.build.json'));

      expect(buildConfig.compilerOptions?.declarationMap).toBe(false);
    }
  });

  it('does not emit JavaScript source maps from publishable package builds', () => {
    for (const dir of ['packages/ai', 'packages/agent', 'packages/agent-sdk']) {
      const tsupConfig = readFileSync(join(dir, 'tsup.config.ts'), 'utf-8');

      expect(tsupConfig).toContain('sourcemap: false');
      expect(tsupConfig).not.toContain('sourcemap: true');
    }
  });

  it('declares a package boundary verifier for production architecture gates', () => {
    const root = readJson('package.json');

    expect(root.scripts?.['verify:boundaries']).toBe('node scripts/verify-package-boundaries.mjs');
    expect(existsSync(join('scripts', 'verify-package-boundaries.mjs'))).toBe(true);
  });

  it('fresh-builds every publishable package before package verification', () => {
    const root = readJson('package.json');
    const packageVerifierSource = readFileSync('scripts/verify-packages.mjs', 'utf-8');
    const sharedRules = readFileSync('scripts/agent-sdk-boundary-rules.mjs', 'utf-8');

    expect(root.scripts?.['verify:packages']).toContain('pnpm --filter @blade-ai/ai run build');
    expect(root.scripts?.['verify:packages']).toContain('pnpm --filter @blade-ai/agent run build');
    expect(root.scripts?.['verify:packages']).toContain(
      'pnpm --filter @blade-ai/agent-sdk run build',
    );
    expect(root.scripts?.['verify:packages']).toContain('node scripts/verify-packages.mjs');
    expect(packageVerifierSource).toContain('package/dist/session/factory.d.ts');
    expect(packageVerifierSource).toContain('toPackedForbiddenFileRules(agentSdkSessionFactoryDeclarationBoundaryRules)');
    expect(sharedRules).toContain('fork(options');
    expect(sharedRules).toContain('prompt(message');
    expect(packageVerifierSource).toContain('verifyNoEagerLegacySessionRuntime');
    expect(packageVerifierSource).toContain('collectPackedStaticImports');
    expect(packageVerifierSource).toContain('package/dist/session/index.js');
    expect(packageVerifierSource).toContain('toPackedForbiddenFileRules(agentSdkSessionPublicDeclarationBoundaryRules)');
    expect(sharedRules).toContain("runtime?: 'kernel' | 'legacy'");
    expect(sharedRules).toContain('experimentalKernel');
    expect(sharedRules).toContain('legacyStream');
    expect(sharedRules).toContain('packageLocalLegacy');
    expect(packageVerifierSource).toContain('package/dist/agent/Agent.d.ts');
    expect(packageVerifierSource).toContain('package/dist/context/ContextManager.d.ts');
    expect(packageVerifierSource).toContain('package/dist/mcp/McpRegistry.d.ts');
    expect(packageVerifierSource).toContain("entry.endsWith('.d.ts.map')");
    expect(packageVerifierSource).toContain("entry.endsWith('.js.map')");
  });

  it('keeps the root session stream contract kernel-only', () => {
    const rootSessionTypes = readFileSync('src/session/types.ts', 'utf-8');
    const rootSessionRuntime = readFileSync('src/session/Session.ts', 'utf-8');

    expect(rootSessionTypes).toContain('includeThinking?: boolean');
    expect(rootSessionTypes).not.toContain("runtime?: 'kernel' | 'legacy'");
    expect(rootSessionTypes).not.toContain('experimentalKernel');
    expect(rootSessionRuntime).not.toContain("runtime === 'legacy'");
    expect(rootSessionRuntime).not.toContain("runtime === 'kernel'");
    expect(rootSessionRuntime).not.toContain('experimentalKernel');
  });
});
