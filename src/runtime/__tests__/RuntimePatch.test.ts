import { describe, expect, it } from 'vitest';
import {
  summarizeRuntimePatchApplications,
  type RuntimePatchApplication,
} from '../index.js';

describe('RuntimePatch', () => {
  it('summarizes prompt append layers in application order', () => {
    const applications: RuntimePatchApplication[] = [
      {
        patch: {
          scope: 'session',
          source: 'tool',
          systemPromptAppend: '  PATCH A  ',
        },
        provenance: {
          toolName: 'PatchA',
          appliedAt: 1,
        },
      },
      {
        patch: {
          scope: 'session',
          source: 'tool',
          systemPromptAppend: 'PATCH B',
        },
        provenance: {
          toolName: 'PatchB',
          appliedAt: 2,
        },
      },
    ];

    expect(summarizeRuntimePatchApplications(applications)).toMatchObject({
      promptAppends: ['PATCH A', 'PATCH B'],
      mergedPromptAppend: 'PATCH A\n\n---\n\nPATCH B',
    });
  });

  it('merges environment layers with last-write-wins semantics', () => {
    const applications: RuntimePatchApplication[] = [
      {
        patch: {
          scope: 'session',
          source: 'tool',
          environment: {
            ENV_A: '1',
            SHARED: 'a',
          },
        },
        provenance: {
          toolName: 'PatchEnvA',
          appliedAt: 1,
        },
      },
      {
        patch: {
          scope: 'session',
          source: 'tool',
          environment: {
            ENV_B: '2',
            SHARED: 'b',
          },
        },
        provenance: {
          toolName: 'PatchEnvB',
          appliedAt: 2,
        },
      },
    ];

    expect(summarizeRuntimePatchApplications(applications)).toMatchObject({
      mergedEnvironment: {
        ENV_A: '1',
        ENV_B: '2',
        SHARED: 'b',
      },
    });
  });
});
