import { describe, expect, it } from 'vitest';
import {
  createPackageLocalRuntimeToolFilterOperations,
  filterPackageLocalRuntimeTools,
} from '../session/runtimeToolFilters.js';

describe('agent-sdk package-local runtime tool filtering helpers', () => {
  it('applies allowlist and denylist policy without session runtime state', () => {
    const tools = [{ name: 'read' }, { name: 'write' }, { name: 'search' }];

    expect(filterPackageLocalRuntimeTools(tools, {})).toEqual(tools);
    expect(filterPackageLocalRuntimeTools(tools, { allowedTools: [] })).toEqual([]);
    expect(
      filterPackageLocalRuntimeTools(tools, {
        allowedTools: ['read', 'write'],
        disallowedTools: ['write'],
      }),
    ).toEqual([{ name: 'read' }]);
    expect(
      filterPackageLocalRuntimeTools(tools, {
        disallowedTools: ['search'],
      }),
    ).toEqual([{ name: 'read' }, { name: 'write' }]);
  });

  it('creates filter operations that retain explicit allowlist policy', () => {
    const tools = [{ name: 'read' }, { name: 'write' }, { name: 'search' }];

    expect(
      createPackageLocalRuntimeToolFilterOperations({
        allowedTools: ['read', 'write'],
        disallowedTools: ['write'],
      }).filter(tools),
    ).toEqual([{ name: 'read' }]);
    expect(
      createPackageLocalRuntimeToolFilterOperations({
        allowedTools: [],
      }).filter(tools),
    ).toEqual([]);
  });
});
