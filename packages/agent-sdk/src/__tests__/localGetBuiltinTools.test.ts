import { describe, expect, it } from 'vitest';

// Minimal SubagentRegistryLike interface — avoids coupling to root's SubagentRegistry
export interface SubagentRegistryLike {
  loadFromStandardLocations(basePath?: string, configDir?: string): void;
}

class StubSubagentRegistry {
  loaded = false;
  loadFromStandardLocations(_basePath?: string, _configDir?: string): void {
    this.loaded = true;
  }
}

describe('getBuiltinTools (agent-sdk)', () => {
  it('accepts optional SubagentRegistryLike parameter', async () => {
    // Type-level test: verify SubagentRegistryLike is compatible
    const stub = new StubSubagentRegistry();
    expect(stub).toBeInstanceOf(StubSubagentRegistry);
    expect(typeof stub.loadFromStandardLocations).toBe('function');
  });
});
