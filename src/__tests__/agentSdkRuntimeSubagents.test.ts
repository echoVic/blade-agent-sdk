import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const subagentsModulePath = '../../packages/agent-sdk/src/session/runtimeSubagents.js';
const subagentsSourcePath = 'packages/agent-sdk/src/session/runtimeSubagents.ts';

describe('agent-sdk package-local runtime subagent helpers', () => {
  it('maps session agent definitions to package-local subagent configs without runtime state', async () => {
    expect(existsSync(subagentsSourcePath)).toBe(true);

    const { packageLocalSubagentConfigFromDefinition } = await import(subagentsModulePath);

    expect(
      packageLocalSubagentConfigFromDefinition('reviewer', {
        description: 'Review code',
        systemPrompt: 'Be direct',
        allowedTools: ['read', 'edit'],
      }),
    ).toEqual({
      name: 'reviewer',
      description: 'Review code',
      systemPrompt: 'Be direct',
      tools: ['read', 'edit'],
      model: 'inherit',
      source: 'session',
    });

    expect(
      packageLocalSubagentConfigFromDefinition('reviewer', {
        name: 'strict-reviewer',
        description: 'Review code strictly',
        systemPrompt: 'Be stricter',
        model: 'glm-5.2',
      }),
    ).toMatchObject({
      name: 'strict-reviewer',
      model: 'glm-5.2',
      source: 'session',
    });
  });

  it('initializes runtime subagent registry without session runtime state', async () => {
    expect(existsSync(subagentsSourcePath)).toBe(true);

    const { initializePackageLocalRuntimeSubagents } = await import(subagentsModulePath);
    const calls: unknown[] = [];
    const logger = {
      warn() {},
    };

    initializePackageLocalRuntimeSubagents({
      subagentRegistry: {
        setLogger(value: unknown) {
          calls.push(['setLogger', value]);
        },
        setProjectDir(projectDir?: string) {
          calls.push(['setProjectDir', projectDir]);
        },
        loadFromStandardLocations(projectDir?: string, storageRoot?: string) {
          calls.push(['loadFromStandardLocations', projectDir, storageRoot]);
          return 2;
        },
        register(config: unknown, options?: unknown) {
          calls.push(['register', config, options]);
        },
      },
      logger,
      projectPath: '/repo',
      storageRoot: '/storage',
      agents: {
        reviewer: {
          description: 'Review code',
          systemPrompt: 'Be direct',
          allowedTools: ['read'],
        },
      },
    });

    expect(calls).toEqual([
      ['setLogger', logger],
      ['setProjectDir', '/repo'],
      ['loadFromStandardLocations', '/repo', '/storage'],
      [
        'register',
        {
          name: 'reviewer',
          description: 'Review code',
          systemPrompt: 'Be direct',
          tools: ['read'],
          model: 'inherit',
          source: 'session',
        },
        {
          override: true,
        },
      ],
    ]);
  });

  it('bundles runtime subagent initialization behind injected ports', async () => {
    expect(existsSync(subagentsSourcePath)).toBe(true);

    const { createPackageLocalRuntimeSubagentOperations } = await import(subagentsModulePath);
    const calls: unknown[] = [];
    const logger = {
      warn() {},
    };

    const operations = createPackageLocalRuntimeSubagentOperations({
      subagentRegistry: {
        setLogger(value: unknown) {
          calls.push(['setLogger', value]);
        },
        setProjectDir(projectDir?: string) {
          calls.push(['setProjectDir', projectDir]);
        },
        loadFromStandardLocations(projectDir?: string, storageRoot?: string) {
          calls.push(['loadFromStandardLocations', projectDir, storageRoot]);
          return 1;
        },
        register(config: unknown, options?: unknown) {
          calls.push(['register', config, options]);
        },
      },
      logger,
      projectPath: '/repo',
      storageRoot: '/storage',
      agents: {
        reviewer: {
          description: 'Review code',
          systemPrompt: 'Be direct',
          allowedTools: ['read'],
        },
      },
    });

    operations.initialize();

    expect(calls).toEqual([
      ['setLogger', logger],
      ['setProjectDir', '/repo'],
      ['loadFromStandardLocations', '/repo', '/storage'],
      [
        'register',
        {
          name: 'reviewer',
          description: 'Review code',
          systemPrompt: 'Be direct',
          tools: ['read'],
          model: 'inherit',
          source: 'session',
        },
        {
          override: true,
        },
      ],
    ]);
  });
});
