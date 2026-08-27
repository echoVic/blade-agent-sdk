import { afterEach, describe, expect, it } from 'vitest';
import { buildShellEnvironment } from '../environment.js';

const SECRET_KEY = 'BLADE_TEST_HOST_SECRET';
const originalSecret = process.env[SECRET_KEY];

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env[SECRET_KEY];
  } else {
    process.env[SECRET_KEY] = originalSecret;
  }
});

describe('buildShellEnvironment', () => {
  it('does not inherit arbitrary host process variables', () => {
    process.env[SECRET_KEY] = 'host-secret';

    const environment = buildShellEnvironment();

    expect(environment[SECRET_KEY]).toBeUndefined();
    expect(environment.BLADE_CLI).toBe('1');
    expect(environment.PATH).toBe(process.env.PATH);
  });

  it('merges explicit runtime and invocation variables', () => {
    process.env[SECRET_KEY] = 'host-secret';

    const environment = buildShellEnvironment(
      {
        RUNTIME_ONLY: 'runtime',
        OVERRIDE: 'runtime',
      },
      {
        COMMAND_ONLY: 'command',
        OVERRIDE: 'command',
      },
    );

    expect(environment).toMatchObject({
      RUNTIME_ONLY: 'runtime',
      COMMAND_ONLY: 'command',
      OVERRIDE: 'command',
      BLADE_CLI: '1',
    });
    expect(environment[SECRET_KEY]).toBeUndefined();
  });
});
