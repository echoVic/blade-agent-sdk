import { describe, expect, it } from 'vitest';
import type { Assert, IsEqual } from '../local/typeAssertions.js';
import { MessageRole, PermissionMode } from '../index.js';
import type { BladeConfig, NetworkSandboxSettings } from '../index.js';
import type { BladeConfig as ToolsBladeConfig } from '../tools/types/index.js';
import type { NetworkSandboxSettings as CommonNetworkSandboxSettings } from '../types/common.js';

/**
 * Slice #349 — root src/types/common.ts shim completion.
 *
 * The root common-type barrel is now fully type-clean: duplicate
 * value+type re-exports removed, and the @blade-ai/agent-sdk barrel gained
 * the missing `BladeConfig` (from tools/types) and `NetworkSandboxSettings`
 * (from types/common via core) exports. Root type-check is 0 errors.
 */

type _BladeConfigIsCanonical = Assert<IsEqual<BladeConfig, ToolsBladeConfig>>;
type _NetworkSandboxSettingsIsCanonical = Assert<
  IsEqual<NetworkSandboxSettings, CommonNetworkSandboxSettings>
>;

describe('root types/common shim completion (slice #349)', () => {
  it('re-exports canonical BladeConfig and NetworkSandboxSettings', () => {
    expect(typeof PermissionMode).toBe('object');
    expect(typeof MessageRole).toBe('object');
  });
});
