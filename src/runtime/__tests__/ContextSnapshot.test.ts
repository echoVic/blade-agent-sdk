import { describe, expect, it } from 'vitest';
import { SessionId } from '../../types/branded.js';
import {
  createContextSnapshot,
  hasFilesystemCapability,
  mergeContext,
} from '../index.js';

describe('ContextSnapshot', () => {
  it('should let turn-scoped filesystem roots override session-level roots', () => {
    const merged = mergeContext(
      {
        capabilities: {
          filesystem: {
            roots: ['/session-root'],
            cwd: '/session-root',
          },
        },
      },
      {
        capabilities: {
          filesystem: {
            roots: ['/turn-root'],
            cwd: '/turn-root',
          },
        },
      },
    );

    expect(merged.capabilities?.filesystem?.roots).toEqual(['/turn-root']);
    expect(merged.capabilities?.filesystem?.cwd).toBe('/turn-root');
  });

  it('should create a snapshot with convenience accessors derived from context', () => {
    const snapshot = createContextSnapshot(
      SessionId('session-1'),
      'turn-1',
      {
        capabilities: {
          filesystem: {
            roots: ['/repo'],
            cwd: '/repo',
          },
        },
        environment: {
          FOO: 'bar',
        },
      },
    );

    expect(snapshot.filesystemRoots).toEqual(['/repo']);
    expect(snapshot.cwd).toBe('/repo');
    expect(snapshot.environment).toEqual({ FOO: 'bar' });
  });

  it('should report filesystem capability only when snapshot roots are present', () => {
    expect(hasFilesystemCapability()).toBe(false);
    expect(
      hasFilesystemCapability(createContextSnapshot(SessionId('s'), 't', {})),
    ).toBe(false);
    expect(
      hasFilesystemCapability(createContextSnapshot(SessionId('s'), 't', {
        capabilities: {
          filesystem: {
            roots: ['/repo'],
          },
        },
      })),
    ).toBe(true);
  });
});
