import { describe, expect, it } from 'vitest';
import {
  getRuntimePatchEffect,
  normalizePermissionEffects,
  normalizeToolEffects,
} from '../ToolEffects.js';

describe('ToolEffects helpers', () => {
  it('normalizes legacy tool result fields into effect entries', () => {
    const runtimePatch = {
      scope: 'session' as const,
      source: 'tool' as const,
      toolDiscovery: {
        discover: ['DiscoverTools'],
      },
    };

    const effects = normalizeToolEffects({
      runtimePatch,
      contextPatch: {
        scope: 'turn',
        context: {
          metadata: {
            discoveredTools: ['DiscoverTools'],
          },
        },
      },
      newMessages: [
        {
          role: 'assistant',
          content: 'hello',
        },
      ],
    });

    expect(effects).toEqual([
      {
        type: 'runtimePatch',
        patch: runtimePatch,
      },
      {
        type: 'contextPatch',
        patch: {
          scope: 'turn',
          context: {
            metadata: {
              discoveredTools: ['DiscoverTools'],
            },
          },
        },
      },
      {
        type: 'newMessages',
        messages: [
          {
            role: 'assistant',
            content: 'hello',
          },
        ],
      },
    ]);
  });

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
