import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  DockerExecutionHost,
  type DockerExecutionHostOptions,
} from '../DockerExecutionHost.js';
import type {
  ExecutionProvisionRequest,
  ExecutionResourceLimits,
} from '../ExecutionHost.js';

const pinnedImage = `example.invalid/agent@sha256:${'a'.repeat(64)}`;
const resources: ExecutionResourceLimits = {
  cpus: 0.5,
  memoryBytes: 64 * 1024 * 1024,
  diskBytes: 16 * 1024 * 1024,
  pids: 64,
  runtimeMs: 30_000,
  maxOutputBytes: 1024 * 1024,
};

function request(
  overrides: Partial<ExecutionProvisionRequest> = {},
): ExecutionProvisionRequest {
  return {
    image: pinnedImage,
    workspace: { kind: 'empty' },
    resources,
    network: { mode: 'none' },
    ...overrides,
  };
}

describe('DockerExecutionHost validation', () => {
  it('requires a numeric, non-root uid and gid', () => {
    for (const containerUser of [
      'root',
      '1000',
      '0:1000',
      '1000:0',
      'user:group',
    ]) {
      expect(() => new DockerExecutionHost({ containerUser }))
        .toThrow(/numeric uid:gid/);
    }
  });

  it('rejects mutable image tags before contacting the runtime', async () => {
    const host = new DockerExecutionHost({
      runtimeBinary: '/definitely/missing/docker',
    });

    await expect(host.provision(request({
      image: 'alpine:latest',
    }))).rejects.toMatchObject({
      code: 'EXECUTION_INVALID_REQUEST',
    });
  });

  it.each(['GITHUB_TOKEN', 'APIKEY', 'MYTOKEN', 'KEY_API'])(
    'rejects likely long-lived secret name %s in persistent environments',
    async (name) => {
    const host = new DockerExecutionHost({
      runtimeBinary: '/definitely/missing/docker',
    });

    await expect(host.provision(request({
      environment: {
        [name]: 'long-lived-value',
      },
    }))).rejects.toMatchObject({
      code: 'EXECUTION_INVALID_REQUEST',
    });
    },
  );

  it.each([
    ['cpus', 0],
    ['memoryBytes', 1024],
    ['diskBytes', 1024],
    ['pids', 0],
    ['runtimeMs', 0],
    ['maxOutputBytes', 0],
  ] satisfies ReadonlyArray<
    readonly [keyof ExecutionResourceLimits, number]
  >)(
    'rejects an invalid %s limit before contacting the runtime',
    async (name, value) => {
      const host = new DockerExecutionHost({
        runtimeBinary: '/definitely/missing/docker',
      });

      await expect(host.provision(request({
        resources: {
          ...resources,
          [name]: value,
        },
      }))).rejects.toMatchObject({
        code: 'EXECUTION_RESOURCE_LIMIT',
      });
    },
  );

  it('fails closed when proxy egress has no controller', async () => {
    const host = new DockerExecutionHost({
      runtimeBinary: '/definitely/missing/docker',
    });

    await expect(host.provision(request({
      network: {
        mode: 'proxy',
        allowedHosts: ['api.example.com'],
      },
    }))).rejects.toMatchObject({
      code: 'EXECUTION_NETWORK_POLICY',
    });
  });

  it.each([
    [[]],
    [['.example.com']],
    [['example.com', 'EXAMPLE.COM']],
    [['https://example.com']],
  ] as const)('rejects invalid proxy host allowlists: %j', async (allowedHosts) => {
    const options: DockerExecutionHostOptions = {
      runtimeBinary: '/definitely/missing/docker',
      egressController: {
        async provision() {
          throw new Error('not reached');
        },
        async release() {},
      },
    };
    const host = new DockerExecutionHost(options);

    await expect(host.provision(request({
      network: {
        mode: 'proxy',
        allowedHosts,
      },
    }))).rejects.toMatchObject({
      code: 'EXECUTION_NETWORK_POLICY',
    });
  });

  it('rejects non-JSON metadata before contacting the runtime', async () => {
    const host = new DockerExecutionHost({
      runtimeBinary: '/definitely/missing/docker',
    });
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;

    await expect(host.provision(request({
      metadata: metadata as never,
    }))).rejects.toMatchObject({
      code: 'EXECUTION_INVALID_REQUEST',
    });
  });
});
