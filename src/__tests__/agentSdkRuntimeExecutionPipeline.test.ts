import { describe, expect, it, vi } from 'vitest';
import {
  createPackageLocalRuntimeExecutionPipeline,
  createPackageLocalRuntimeExecutionPipelineCache,
  createPackageLocalRuntimeExecutionPipelineOperations,
} from '../../packages/agent-sdk/src/session/runtimeExecutionPipeline.js';
import type { PackageLocalRuntimeExecutionPipelineFactoryPort } from '../../packages/agent-sdk/src/session/runtimeExecutionPipeline.js';
import { PermissionMode, type BladeConfig } from '../../packages/agent-sdk/src/types/common.js';

const bladeConfig: BladeConfig = {
  currentModelId: 'default',
  temperature: 0.7,
  models: [],
};

describe('agent-sdk package-local runtime execution pipeline helpers', () => {
  it('creates a pipeline with default permission config and permission mode', () => {
    const pipeline = { id: 'pipeline' };
    const factory: PackageLocalRuntimeExecutionPipelineFactoryPort = {
      create: vi.fn(() => pipeline),
    };
    const logger = { warn: vi.fn() };
    const toolCatalog = {};

    const created = createPackageLocalRuntimeExecutionPipeline({
      bladeConfig,
      executionPipelineFactory: factory,
      permissionHandler: undefined,
      logger,
      toolCatalog,
    });

    expect(created).toBe(pipeline);
    expect(factory.create).toHaveBeenCalledWith({
      permissionConfig: {
        allow: [],
        ask: [],
        deny: [],
      },
      permissionMode: PermissionMode.DEFAULT,
      maxHistorySize: 1000,
      permissionHandler: undefined,
      logger,
      toolCatalog,
    });
  });

  it('passes configured permissions, mode, handler, logger, and tool catalog to the factory', () => {
    const pipeline = { id: 'configured-pipeline' };
    const factory: PackageLocalRuntimeExecutionPipelineFactoryPort = {
      create: vi.fn(() => pipeline),
    };
    const permissionHandler = vi.fn(async () => ({ behavior: 'allow' as const }));
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const toolCatalog = {
      registerAll: vi.fn(),
    };

    const created = createPackageLocalRuntimeExecutionPipeline({
      bladeConfig: {
        ...bladeConfig,
        permissions: {
          allow: ['Read'],
          ask: ['Write'],
          deny: ['Bash'],
        },
      },
      permissionMode: PermissionMode.YOLO,
      executionPipelineFactory: factory,
      permissionHandler,
      logger,
      toolCatalog,
    });

    expect(created).toBe(pipeline);
    expect(factory.create).toHaveBeenCalledWith({
      permissionConfig: {
        allow: ['Read'],
        ask: ['Write'],
        deny: ['Bash'],
      },
      permissionMode: PermissionMode.YOLO,
      maxHistorySize: 1000,
      permissionHandler,
      logger,
      toolCatalog,
    });
  });

  it('caches runtime execution pipeline creation outside the session runtime class', () => {
    const pipeline = { id: 'cached-pipeline' };
    const createPipeline = vi.fn(() => pipeline);

    const cache = createPackageLocalRuntimeExecutionPipelineCache(createPipeline);

    expect(cache.get()).toBe(pipeline);
    expect(cache.get()).toBe(pipeline);
    expect(createPipeline).toHaveBeenCalledTimes(1);
  });

  it('creates pipeline operations that lazily cache configured pipeline creation', () => {
    const pipeline = { id: 'operations-pipeline' };
    const factory: PackageLocalRuntimeExecutionPipelineFactoryPort = {
      create: vi.fn(() => pipeline),
    };
    const permissionHandler = vi.fn(async () => ({ behavior: 'allow' as const }));
    const createPermissionHandler = vi.fn(() => permissionHandler);
    const logger = { warn: vi.fn() };
    const toolCatalog = {};
    const operations = createPackageLocalRuntimeExecutionPipelineOperations({
      bladeConfig,
      permissionMode: PermissionMode.PLAN,
      createPermissionHandler,
      logger,
      toolCatalog,
      executionPipelineFactory: factory,
    });

    expect(operations.get()).toBe(pipeline);
    expect(operations.get()).toBe(pipeline);
    expect(createPermissionHandler).toHaveBeenCalledTimes(1);
    expect(factory.create).toHaveBeenCalledTimes(1);
    expect(factory.create).toHaveBeenCalledWith({
      permissionConfig: {
        allow: [],
        ask: [],
        deny: [],
      },
      permissionMode: PermissionMode.PLAN,
      maxHistorySize: 1000,
      permissionHandler,
      logger,
      toolCatalog,
    });
  });
});
