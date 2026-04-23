import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOOP_LOGGER } from '../../logging/Logger.js';
import type { RuntimeContext } from '../../runtime/index.js';
import { SessionId } from '../../types/branded.js';
import { PermissionMode } from '../../types/common.js';
import type { SessionOptions } from '../types.js';

const { SessionRuntime } = await import('../SessionRuntime.js');

function createOptions(overrides: Partial<SessionOptions> = {}): SessionOptions {
  return {
    provider: { type: 'openai-compatible', apiKey: 'test-key' },
    model: 'gpt-4o-mini',
    storagePath: overrides.storagePath,
    ...overrides,
  };
}

function createFilesystemContext(workspaceRoot: string): RuntimeContext {
  return {
    capabilities: {
      filesystem: {
        roots: [workspaceRoot],
        cwd: workspaceRoot,
      },
    },
  };
}

function getTaskDescription(runtime: InstanceType<typeof SessionRuntime>): string {
  const taskTool = runtime.getToolRegistry().get('Task');
  if (!taskTool) {
    throw new Error('Task tool not registered');
  }

  return taskTool.getFunctionDeclaration().description;
}

describe('SessionRuntime subagents', () => {
  let workspaceRoot: string;
  const runtimes: InstanceType<typeof SessionRuntime>[] = [];

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'session-runtime-subagents-'));
  });

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  it('registers session agents per runtime without leaking across sessions', async () => {
    const runtimeA = new SessionRuntime(
      SessionId('session-a'),
      createOptions({
        agents: {
          'session-auditor': {
            name: 'session-auditor',
            description: 'Review code changes',
            systemPrompt: 'Review the provided diff for bugs.',
            allowedTools: ['Read', 'Glob', 'Grep'],
          },
        },
      }),
      {
        models: [],
      },
      PermissionMode.DEFAULT,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );
    const runtimeB = new SessionRuntime(
      SessionId('session-b'),
      createOptions(),
      {
        models: [],
      },
      PermissionMode.DEFAULT,
      createFilesystemContext(workspaceRoot),
      NOOP_LOGGER,
    );
    runtimes.push(runtimeA, runtimeB);

    await runtimeA.initialize();
    await runtimeB.initialize();

    const descriptionA = getTaskDescription(runtimeA);
    const descriptionB = getTaskDescription(runtimeB);

    expect(descriptionA).toContain('general-purpose');
    expect(descriptionA).toContain('session-auditor');
    expect(descriptionA).not.toContain('verification');

    expect(descriptionB).toContain('general-purpose');
    expect(descriptionB).not.toContain('session-auditor');
    expect(descriptionB).not.toContain('verification');
  });
});
