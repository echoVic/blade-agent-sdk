import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const runtimeAgentDepsModulePath = '../session/runtimeAgentDeps.js';
const runtimeAgentDepsSourcePath = 'src/session/runtimeAgentDeps.ts';

describe('agent-sdk package-local runtime agent dependency helpers', () => {
  it('projects agent runtime dependencies without session runtime state', async () => {
    expect(existsSync(runtimeAgentDepsSourcePath)).toBe(true);

    const { createPackageLocalAgentRuntimeDeps } = await import(runtimeAgentDepsModulePath);
    const executionPipeline = { id: 'pipeline' };
    const defaultContext = { cwd: '/workspace' };
    const mcpRegistry = { disconnectAll: vi.fn() };
    const subagentRegistry = { register: vi.fn() };
    const backgroundAgentManager = { run: vi.fn() };
    const hookRuntime = { enable: vi.fn() };
    const logger = { warn: vi.fn() };

    expect(
      createPackageLocalAgentRuntimeDeps({
        executionPipeline,
        defaultContext,
        mcpRegistry,
        subagentRegistry,
        backgroundAgentManager,
        hookRuntime,
        logger,
      }),
    ).toEqual({
      executionPipeline,
      defaultContext,
      mcpRegistry,
      subagentRegistry,
      backgroundAgentManager,
      hookRuntime,
      runtimeManaged: true,
      logger,
    });
  });

  it('creates reusable agent runtime dependency operations without session runtime state', async () => {
    expect(existsSync(runtimeAgentDepsSourcePath)).toBe(true);

    const { createPackageLocalAgentRuntimeDepsOperations } = await import(
      runtimeAgentDepsModulePath
    );
    const executionPipeline = { id: 'pipeline' };
    const createExecutionPipeline = vi.fn(() => executionPipeline);
    const defaultContext = { cwd: '/workspace' };
    const mcpRegistry = { disconnectAll: vi.fn() };
    const subagentRegistry = { register: vi.fn() };
    const backgroundAgentManager = { run: vi.fn() };
    const hookRuntime = { enable: vi.fn() };
    const logger = { warn: vi.fn() };

    const operations = createPackageLocalAgentRuntimeDepsOperations({
      createExecutionPipeline,
      defaultContext,
      mcpRegistry,
      subagentRegistry,
      backgroundAgentManager,
      hookRuntime,
      logger,
    });

    expect(operations.get()).toEqual({
      executionPipeline,
      defaultContext,
      mcpRegistry,
      subagentRegistry,
      backgroundAgentManager,
      hookRuntime,
      runtimeManaged: true,
      logger,
    });
    expect(createExecutionPipeline).toHaveBeenCalledOnce();
  });
});
