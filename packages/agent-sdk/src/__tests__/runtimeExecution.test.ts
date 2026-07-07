import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PermissionMode } from '../types/common.js';

const runtimeExecutionModulePath = '../session/runtimeExecution.js';
const runtimeExecutionSourcePath = 'src/session/runtimeExecution.ts';

describe('agent-sdk package-local runtime execution operations', () => {
  it('bundles execution pipeline and agent runtime dependency operations behind injected ports', async () => {
    expect(existsSync(runtimeExecutionSourcePath)).toBe(true);

    const { createPackageLocalRuntimeExecutionOperations } = await import(
      runtimeExecutionModulePath
    );
    const pipeline = { id: 'pipeline' };
    const createPermissionHandler = vi.fn(() => undefined);
    const executionPipelineFactory = {
      create: vi.fn(() => pipeline),
    };
    const logger = { warn: vi.fn() };
    const toolCatalog = {};
    const defaultContext = { cwd: '/workspace' };
    const mcpRegistry = { disconnectAll: vi.fn() };
    const subagentRegistry = { register: vi.fn() };
    const backgroundAgentManager = { run: vi.fn() };
    const hookRuntime = { enable: vi.fn() };

    const operations = createPackageLocalRuntimeExecutionOperations({
      bladeConfig: {
        currentModelId: 'default',
        temperature: 0.7,
        permissions: {
          allow: ['Read'],
          ask: ['Write'],
          deny: [],
        },
        models: [],
      },
      permissionMode: PermissionMode.PLAN,
      createPermissionHandler,
      logger,
      toolCatalog,
      executionPipelineFactory,
      defaultContext,
      mcpRegistry,
      subagentRegistry,
      backgroundAgentManager,
      hookRuntime,
    });

    expect(operations.pipeline.get()).toBe(pipeline);
    expect(operations.pipeline.get()).toBe(pipeline);
    expect(operations.agentDeps.get()).toEqual({
      executionPipeline: pipeline,
      defaultContext,
      mcpRegistry,
      subagentRegistry,
      backgroundAgentManager,
      hookRuntime,
      runtimeManaged: true,
      logger,
    });
    expect(createPermissionHandler).toHaveBeenCalledOnce();
    expect(executionPipelineFactory.create).toHaveBeenCalledOnce();
    expect(executionPipelineFactory.create).toHaveBeenCalledWith({
      permissionConfig: {
        allow: ['Read'],
        ask: ['Write'],
        deny: [],
      },
      permissionMode: PermissionMode.PLAN,
      maxHistorySize: 1000,
      permissionHandler: undefined,
      logger,
      toolCatalog,
    });
  });
});
