import { describe, expect, it, vi } from 'vitest';
import {
  createPackageLocalRuntimeControlOperations,
} from '../../packages/agent-sdk/src/session/runtimeControls.js';
import type { RuntimeContext } from '../../packages/agent-sdk/src/runtime/types.js';
import { PermissionMode, type BladeConfig } from '../../packages/agent-sdk/src/types/common.js';
import type { SessionOptions } from '../../packages/agent-sdk/src/session/types.js';

describe('agent-sdk package-local runtime control helpers', () => {
  it('updates session control state through package-local operations', async () => {
    const options: SessionOptions = {
      provider: {
        type: 'openai-compatible',
        apiKey: 'test-key',
        baseUrl: 'https://example.com/v1',
      },
      model: 'model-a',
      temperature: 0.2,
      maxOutputTokens: 512,
      maxContextTokens: 8192,
      permissionMode: PermissionMode.DEFAULT,
    };
    const bladeConfig: BladeConfig = {
      models: [],
      currentModelId: 'default',
      permissions: {
        allow: [],
        deny: [],
      },
    };
    let defaultContext: RuntimeContext = {};
    let projectPath: string | undefined;
    const resetExecutionPipeline = vi.fn();
    const markSubagentLocationsDirty = vi.fn();

    const operations = createPackageLocalRuntimeControlOperations({
      options,
      bladeConfig,
      setDefaultContext(context) {
        defaultContext = context;
      },
      setProjectPath(path) {
        projectPath = path;
      },
      resetExecutionPipeline,
      markSubagentLocationsDirty,
    });

    const nextContext: RuntimeContext = {
      capabilities: {
        filesystem: {
          roots: ['/workspace'],
          cwd: '/workspace/project',
        },
      },
    };

    operations.setDefaultContext(nextContext);
    operations.setPermissionMode(PermissionMode.YOLO);
    await operations.setModel('model-b');
    operations.setMaxTurns(3);

    expect(defaultContext).toBe(nextContext);
    expect(projectPath).toBe('/workspace/project');
    expect(markSubagentLocationsDirty).toHaveBeenCalledTimes(1);
    expect(options.permissionMode).toBe(PermissionMode.YOLO);
    expect(resetExecutionPipeline).toHaveBeenCalledTimes(1);
    expect(options.model).toBe('model-b');
    expect(options.maxTurns).toBe(3);
    expect(bladeConfig.currentModelId).toBe(bladeConfig.models[0]?.id);
    expect(bladeConfig.models).toEqual([
      expect.objectContaining({
        model: 'model-b',
        temperature: 0.2,
        maxOutputTokens: 512,
        maxContextTokens: 8192,
      }),
    ]);
  });
});
