import { describe, expect, it, vi } from 'vitest';
import type { RuntimeContext } from '../runtime/types.js';
import type { BladeConfig } from '../types/common.js';
import type { SessionOptions } from '../session/types.js';
import { HookEvent } from '../types/constants.js';
import {
  createPackageLocalRuntimeInitialState,
} from '../session/runtimeState.js';

describe('agent-sdk package-local runtime initial state helpers', () => {
  it('derives storage root, project path, and hook callbacks without runtime class state', () => {
    const hooks = {
      [HookEvent.UserPromptSubmit]: [vi.fn()],
    };
    const options: SessionOptions = {
      provider: {
        type: 'openai-compatible',
        apiKey: 'test-key',
      },
      model: 'model-a',
      storagePath: '/workspace/.blade/sessions',
      hooks,
    };
    const bladeConfig: BladeConfig = {
      models: [],
      currentModelId: 'default',
      storageRoot: '/override/root',
      permissions: {
        allow: [],
        deny: [],
      },
    };
    const defaultContext: RuntimeContext = {
      capabilities: {
        filesystem: {
          roots: ['/workspace'],
          cwd: '/workspace/project',
        },
      },
      environment: {
        cwd: '/fallback',
      },
    };

    expect(
      createPackageLocalRuntimeInitialState({
        options,
        bladeConfig,
        defaultContext,
      }),
    ).toEqual({
      storageRoot: '/override/root',
      projectPath: '/workspace/project',
      hookCallbacks: hooks,
    });
  });

  it('falls back to normalized session storage and empty hooks', () => {
    const options: SessionOptions = {
      provider: {
        type: 'openai-compatible',
        apiKey: 'test-key',
      },
      model: 'model-a',
      storagePath: '/workspace/.blade/sessions',
    };
    const bladeConfig: BladeConfig = {
      models: [],
      currentModelId: 'default',
      permissions: {
        allow: [],
        deny: [],
      },
    };

    expect(
      createPackageLocalRuntimeInitialState({
        options,
        bladeConfig,
        defaultContext: {
          environment: {
            cwd: '/env/project',
          },
        },
      }),
    ).toEqual({
      storageRoot: '/workspace/.blade',
      projectPath: '/env/project',
      hookCallbacks: {},
    });
  });
});
