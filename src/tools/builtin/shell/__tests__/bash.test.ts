import { afterEach, describe, expect, it } from 'vitest';
import { createContextSnapshot } from '../../../../runtime/index.js';
import { SessionId } from '../../../../types/identifiers.js';
import { collectToolExecution } from '../../../types/result.js';
import { bashTool } from '../bash.js';

const SECRET_KEY = 'BLADE_TEST_HOST_SECRET';
const originalSecret = process.env[SECRET_KEY];

afterEach(() => {
  if (originalSecret === undefined) {
    delete process.env[SECRET_KEY];
  } else {
    process.env[SECRET_KEY] = originalSecret;
  }
});

describe('Bash tool environment', () => {
  it('does not expose arbitrary host variables and merges explicit environments', async () => {
    process.env[SECRET_KEY] = 'host-secret';
    const invocation = bashTool.build({
      command: 'printf "%s|%s|%s" "$BLADE_TEST_HOST_SECRET" "$RUNTIME_ONLY" "$COMMAND_ONLY"',
      env: {
        COMMAND_ONLY: 'command',
      },
      run_in_background: false,
      timeout: 30_000,
    });

    const result = await collectToolExecution(
      invocation.execute(new AbortController().signal, {
        sessionId: SessionId('bash-environment-session'),
        contextSnapshot: createContextSnapshot(SessionId('bash-environment-session'), 'turn-1', {
          capabilities: {
            filesystem: {
              roots: [process.cwd()],
              cwd: process.cwd(),
            },
          },
          environment: {
            RUNTIME_ONLY: 'runtime',
          },
        }),
      }),
    );

    expect(result).toMatchObject({
      status: 'success',
      model: {
        stdout: '|runtime|command',
        exit_code: 0,
      },
    });
  });

  it('waits for timeout process-tree termination before returning', async () => {
    const invocation = bashTool.build({
      command: "trap 'exit 0' TERM; while true; do sleep 1; done",
      run_in_background: false,
      timeout: 1_000,
    });

    const result = await collectToolExecution(
      invocation.execute(new AbortController().signal, {
        sessionId: SessionId('bash-timeout-session'),
        contextSnapshot: createContextSnapshot(SessionId('bash-timeout-session'), 'turn-1', {
          capabilities: {
            filesystem: {
              roots: [process.cwd()],
              cwd: process.cwd(),
            },
          },
        }),
      }),
    );

    expect(result).toMatchObject({
      status: 'error',
      error: {
        type: 'timeout_error',
      },
    });
  });
});
