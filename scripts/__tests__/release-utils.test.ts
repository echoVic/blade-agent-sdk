import { describe, expect, it } from 'vitest';

import { buildCommandFailureMessage, getPublishEnv } from '../release-utils.js';

describe('getPublishEnv', () => {
  it('uses a temporary npm cache when none is configured', () => {
    const env = getPublishEnv('/tmp/blade-release-cache', {
      PATH: '/usr/bin',
    });

    expect(env.NPM_CONFIG_CACHE).toBe('/tmp/blade-release-cache');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('preserves an explicit npm cache from the environment', () => {
    const env = getPublishEnv('/tmp/blade-release-cache', {
      NPM_CONFIG_CACHE: '/custom/cache',
    });

    expect(env.NPM_CONFIG_CACHE).toBe('/custom/cache');
  });
});

describe('buildCommandFailureMessage', () => {
  it('includes stderr details when available', () => {
    const message = buildCommandFailureMessage('pnpm publish', {
      message: 'Command failed: pnpm publish',
      stderr: Buffer.from('npm error code EPERM\nnpm error path ~/.npm'),
    });

    expect(message).toContain('Command failed: pnpm publish');
    expect(message).toContain('npm error code EPERM');
    expect(message).toContain('npm error path ~/.npm');
  });
});
