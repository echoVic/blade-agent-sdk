import { describe, expect, it, vi } from 'vitest';
import {
  createPackageLocalRuntimeCapabilityStartupOperations,
} from '../../packages/agent-sdk/src/session/runtimeCapabilities.js';

describe('agent-sdk package-local runtime capability startup helpers', () => {
  it('runs runtime capability startup steps in dependency order', async () => {
    const calls: string[] = [];
    const operations = createPackageLocalRuntimeCapabilityStartupOperations({
      async registerConfiguredMcpServers() {
        calls.push('mcp:start');
        await Promise.resolve();
        calls.push('mcp:end');
      },
      registerCustomTools() {
        calls.push('custom');
      },
      async registerBuiltinTools() {
        calls.push('builtin:start');
        await Promise.resolve();
        calls.push('builtin:end');
      },
      initializeSubagents() {
        calls.push('subagents');
      },
      initializeHooks() {
        calls.push('hooks');
      },
    });

    await operations.initializeRuntimeCapabilities();

    expect(calls).toEqual([
      'mcp:start',
      'mcp:end',
      'custom',
      'builtin:start',
      'builtin:end',
      'subagents',
      'hooks',
    ]);
  });

  it('stops later startup steps when an earlier async step fails', async () => {
    const failure = new Error('mcp unavailable');
    const registerCustomTools = vi.fn();
    const registerBuiltinTools = vi.fn();
    const initializeSubagents = vi.fn();
    const initializeHooks = vi.fn();
    const operations = createPackageLocalRuntimeCapabilityStartupOperations({
      registerConfiguredMcpServers: vi.fn(async () => {
        throw failure;
      }),
      registerCustomTools,
      registerBuiltinTools,
      initializeSubagents,
      initializeHooks,
    });

    await expect(operations.initializeRuntimeCapabilities()).rejects.toThrow(failure);
    expect(registerCustomTools).not.toHaveBeenCalled();
    expect(registerBuiltinTools).not.toHaveBeenCalled();
    expect(initializeSubagents).not.toHaveBeenCalled();
    expect(initializeHooks).not.toHaveBeenCalled();
  });
});
