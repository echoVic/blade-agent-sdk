import { describe, expect, it } from 'vitest';
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
});
