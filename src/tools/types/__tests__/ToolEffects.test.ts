import { describe, expect, it } from 'vitest';
import {
  getRuntimePatchEffect,
  normalizePermissionEffects,
} from '../ToolEffects.js';

describe('ToolEffects helpers', () => {
  it('preserves explicit effects and appends permission updates', () => {
    const effects = normalizePermissionEffects({
      effects: [
        {
          type: 'permissionUpdates',
          updates: [
            {
              type: 'addRules',
              behavior: 'allow',
              rules: [{ toolName: 'Read' }],
            },
          ],
        },
      ],
      updatedPermissions: [
        {
          type: 'removeRules',
          rules: [{ toolName: 'Write' }],
        },
      ],
    });

    expect(effects).toEqual([
      {
        type: 'permissionUpdates',
        updates: [
          {
            type: 'addRules',
            behavior: 'allow',
            rules: [{ toolName: 'Read' }],
          },
        ],
      },
      {
        type: 'permissionUpdates',
        updates: [
          {
            type: 'removeRules',
            rules: [{ toolName: 'Write' }],
          },
        ],
      },
    ]);
  });

  it('extracts runtime patches from effect lists', () => {
    expect(
      getRuntimePatchEffect([
        {
          type: 'newMessages',
          messages: [],
        },
        {
          type: 'runtimePatch',
          patch: {
            scope: 'turn',
            source: 'skill',
            skill: {
              id: 'reviewer',
              name: 'reviewer',
              basePath: '/tmp/reviewer',
            },
          },
        },
      ]),
    ).toEqual({
      scope: 'turn',
      source: 'skill',
      skill: {
        id: 'reviewer',
        name: 'reviewer',
        basePath: '/tmp/reviewer',
      },
    });
  });
});
