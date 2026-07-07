import { describe, expect, it } from 'vitest';
import {
  getPackageLocalRuntimeContextCwd,
  resolvePackageLocalRuntimeStorageRoot,
} from '../session/runtimeContext.js';

describe('agent-sdk package-local runtime context helpers', () => {
  it('normalizes session storage paths to their runtime storage root', () => {
    expect(resolvePackageLocalRuntimeStorageRoot('/workspace/.blade/sessions')).toBe(
      '/workspace/.blade',
    );
    expect(resolvePackageLocalRuntimeStorageRoot('/workspace/.blade')).toBe('/workspace/.blade');
    expect(resolvePackageLocalRuntimeStorageRoot(undefined)).toBeUndefined();
  });

  it('derives cwd from filesystem capabilities before environment fallback', () => {
    expect(
      getPackageLocalRuntimeContextCwd({
        capabilities: {
          filesystem: {
            roots: ['/workspace'],
            cwd: '/workspace/project',
          },
        },
        environment: {
          cwd: '/workspace/from-env',
        },
      }),
    ).toBe('/workspace/project');

    expect(
      getPackageLocalRuntimeContextCwd({
        environment: {
          cwd: '/workspace/from-env',
        },
      }),
    ).toBe('/workspace/from-env');

    expect(getPackageLocalRuntimeContextCwd({})).toBeUndefined();
  });
});
