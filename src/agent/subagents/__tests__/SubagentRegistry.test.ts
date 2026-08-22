import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SubagentRegistry } from '../SubagentRegistry.js';

describe('SubagentRegistry', () => {
  it('loads only the three builtin agent types', () => {
    const registry = new SubagentRegistry();

    registry.loadBuiltinAgents();

    expect(registry.getAllNames()).toEqual([
      'general-purpose',
      'Explore',
      'Plan',
    ]);
  });

  it('allows explicit session-scoped overrides', () => {
    const registry = new SubagentRegistry();

    registry.loadBuiltinAgents();
    registry.register(
      {
        name: 'Plan',
        description: 'Session-specific planner',
        source: 'session',
      },
      { override: true },
    );

    expect(registry.getSubagent('Plan')).toMatchObject({
      description: 'Session-specific planner',
      source: 'session',
    });
  });

  it('does not scan local agent directories without a workspace', () => {
    const registry = new SubagentRegistry();
    const loadFromDirectory = vi.spyOn(registry, 'loadFromDirectory');

    const count = registry.loadFromStandardLocations(undefined, '/storage');

    expect(count).toBe(3);
    expect(registry.getAllNames()).toEqual([
      'general-purpose',
      'Explore',
      'Plan',
    ]);
    expect(loadFromDirectory).not.toHaveBeenCalled();
  });

  it('scans user and project agent directories when a workspace exists', () => {
    const registry = new SubagentRegistry();
    const loadFromDirectory = vi
      .spyOn(registry, 'loadFromDirectory')
      .mockImplementation(() => {});

    registry.loadFromStandardLocations('/workspace', '/storage');

    expect(loadFromDirectory.mock.calls).toEqual([
      [join('/storage', 'agents'), 'user'],
      [join('/workspace', 'agents'), 'project'],
    ]);
  });
});
