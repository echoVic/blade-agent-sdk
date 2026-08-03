import { describe, expect, it } from 'vitest';
import { SessionId } from '../../../types/branded.js';
import {
  getEffectiveProjectDir,
  type ExecutionContext,
  type ExecutionHistoryEntry,
} from '../index.js';
import type {
  ExecutionContext as PackageExecutionContext,
  ExecutionHistoryEntry as PackageExecutionHistoryEntry,
} from '@blade-ai/agent-sdk/tools';
import type { Assert, IsEqual } from '../../../types/typeAssertions.js';

/**
 * Slice #335 — root ExecutionTypes.ts is now a pure re-export shim.
 *
 * The root ExecutionContext (and its helpers) must be IDENTICAL to the
 * package canonical type from @blade-ai/agent-sdk/tools — the former root
 * Omit-extension duplicate (with root-branded overrides) is gone. These
 * compile-time assertions pin the identity so a future regression (someone
 * re-introducing a root-local ExecutionContext definition) fails the build.
 */

type _RootExecutionContextIsPackageCanonical = Assert<
  IsEqual<ExecutionContext, PackageExecutionContext>
>;
type _RootExecutionHistoryEntryIsPackageCanonical = Assert<
  IsEqual<ExecutionHistoryEntry, PackageExecutionHistoryEntry>
>;

describe('root ExecutionTypes shim', () => {
  it('re-exports the package getEffectiveProjectDir helper', () => {
    const context: ExecutionContext = {
      sessionId: SessionId('root-shim-session'),
      contextSnapshot: {
        sessionId: SessionId('root-shim-session'),
        turnId: 'turn-1',
        context: {
          capabilities: {
            filesystem: { roots: ['/workspace'], cwd: '/workspace' },
          },
        },
        filesystemRoots: ['/workspace'],
        cwd: '/workspace',
        environment: {},
      },
    };
    expect(getEffectiveProjectDir(context)).toBe('/workspace');
    expect(getEffectiveProjectDir({})).toBeUndefined();
  });
});
