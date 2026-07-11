import { describe, expect, it } from 'vitest';
import { getPackageName, getVersion } from '../local/packageInfo.js';

describe('package-local packageInfo', () => {
  it('returns a non-empty version string', () => {
    expect(typeof getVersion()).toBe('string');
    expect(getVersion().length).toBeGreaterThan(0);
  });

  it('returns the correct package name', () => {
    expect(getPackageName()).toBe('@blade-ai/agent-sdk');
  });

  it('has a semantic version format', () => {
    const version = getVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
