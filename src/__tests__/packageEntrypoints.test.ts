import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync('package.json', 'utf-8')) as {
  bin: Record<string, string>;
  exports: Record<string, unknown>;
  files: string[];
  scripts: Record<string, string>;
};

describe('package entrypoints', () => {
  it('declares server-first root and explicit subpath exports', () => {
    expect(packageJson.exports).toMatchObject({
      '.': {
        types: './dist/index.d.ts',
        browser: './dist/browser/index.js',
        import: './dist/index.js',
      },
      './core': {
        types: './dist/core/index.d.ts',
        import: './dist/core/index.js',
      },
      './browser': {
        types: './dist/browser/index.d.ts',
        import: './dist/browser/index.js',
      },
      './protocol': {
        types: './dist/protocol/index.d.ts',
        import: './dist/protocol/index.js',
      },
      './server': {
        types: './dist/server/index.d.ts',
        browser: './dist/browser/server-only-stub.js',
        import: './dist/server/index.js',
      },
      './server/postgres': {
        types: './dist/server/postgres.d.ts',
        browser: './dist/browser/server-only-stub.js',
        import: './dist/server/postgres.js',
      },
      './server/otel': {
        types: './dist/server/otel.d.ts',
        browser: './dist/browser/server-only-stub.js',
        import: './dist/server/otel.js',
      },
      './server/testing': {
        types: './dist/server/testing/index.d.ts',
        import: './dist/server/testing/index.js',
      },
      './session': {
        types: './dist/session/index.d.ts',
        browser: './dist/browser/server-only-stub.js',
        import: './dist/session/index.js',
      },
      './tools': {
        types: './dist/tools/index.d.ts',
        import: './dist/tools/index.js',
      },
      './node': {
        types: './dist/node/index.d.ts',
        browser: './dist/browser/server-only-stub.js',
        import: './dist/node/index.js',
      },
      './middleware': {
        types: './dist/middleware/index.d.ts',
        import: './dist/middleware/index.js',
      },
      './model': {
        types: './dist/model/index.d.ts',
        import: './dist/model/index.js',
      },
    });
  });

  it('has source modules for every public subpath entry', () => {
    for (const file of [
      'src/core/index.ts',
      'src/browser/index.ts',
      'src/browser/server-only-stub.ts',
      'src/protocol/index.ts',
      'src/server/index.ts',
      'src/server/otel.ts',
      'src/server/postgres.ts',
      'src/server/testing/index.ts',
      'src/tools/index.ts',
      'src/node/index.ts',
      'src/middleware/index.ts',
      'src/model/index.ts',
      'src/session/index.ts',
    ]) {
      expect(existsSync(join(process.cwd(), file)), file).toBe(true);
    }
  });

  it('declares the browser/server entrypoint verification script', () => {
    expect(packageJson.scripts['verify:entrypoints']).toBe(
      'pnpm run build && node scripts/verify-entrypoints.mjs',
    );
    expect(existsSync(join(process.cwd(), 'scripts/verify-entrypoints.mjs'))).toBe(true);
  });

  it('ships the create-blade-agent executable and its verified template assets', () => {
    expect(packageJson.bin).toEqual({
      'create-blade-agent': './dist/cli/create-blade-agent.js',
    });
    expect(packageJson.files).toEqual(
      expect.arrayContaining([
        'examples/local-cli-agent/index.mjs',
        'examples/production-stack',
        'examples/web-agent-server/client.js',
        'examples/web-agent-server/index.html',
        'examples/web-agent-server/server.mjs',
      ]),
    );
    expect(existsSync(join(process.cwd(), 'src/cli/create-blade-agent.ts'))).toBe(true);
  });

  it('throws clear errors from browser runtime stubs', async () => {
    const browser = await import('../browser/index.js');
    const serverOnly = await import('../browser/server-only-stub.js');

    expect(browser.PermissionMode.DEFAULT).toBe('default');
    expect(browser.ToolSideEffect.PURE).toBe('pure');
    expect(browser.DurableEventType.REQUEST_ACCEPTED).toBe('request_accepted');
    expect(browser.DurableSessionJournal.open).toBeTypeOf('function');
    expect(browser.DurableSessionRecoveryRequiredError).toBeDefined();
    expect(browser.projectDurableSession([]).status).toBe('empty');
    expect(browser.PermissionRequestId('permission-1')).toBe('permission-1');
    expect(browser.ToolUseId('tool-call-1')).toBe('tool-call-1');
    expect(browser.ExecutionId('execution-1')).toBe('execution-1');
    expect(browser.ExecutionCheckpointId('checkpoint-1')).toBe('checkpoint-1');
    expect(browser.CredentialLeaseId('credential-1')).toBe('credential-1');
    expect(browser.AgentClient).toBeTypeOf('function');
    expect(browser.AGENT_PROTOCOL_VERSION).toBe(1);
    expect(() => browser.createSession({} as never)).toThrow(/server-only.*createSession/);
    expect(() => serverOnly.getBuiltinTools()).toThrow(/server-only.*getBuiltinTools/);
    expect(() => new serverOnly.JsonlDurableEventStore()).toThrow(
      /server-only.*JsonlDurableEventStore/,
    );
    expect(() => new serverOnly.AgentServer()).toThrow(/server-only.*AgentServer/);
    expect(() => new serverOnly.PostgresRuntimeStore()).toThrow(
      /server-only.*PostgresRuntimeStore/,
    );
    expect(() => new serverOnly.DockerExecutionHost()).toThrow(
      /server-only.*DockerExecutionHost/,
    );
    expect(() => new serverOnly.EphemeralCredentialBroker()).toThrow(
      /server-only.*EphemeralCredentialBroker/,
    );
    expect(() => new serverOnly.ExecutionHostError()).toThrow(
      /server-only.*ExecutionHostError/,
    );
    expect(() => new serverOnly.WorkerRuntimeError()).toThrow(
      /server-only.*WorkerRuntimeError/,
    );
    expect(serverOnly.RUNTIME_STORE_SCHEMA_VERSION).toBe(3);
    expect(serverOnly.RUNTIME_DOMAIN_EVENT_SCHEMA_VERSION).toBe(1);
    expect(serverOnly.RUNTIME_SESSION_STATES).toEqual([
      'queued',
      'provisioning',
      'running',
      'waiting_approval',
      'suspended',
      'idle',
      'completed',
      'failed',
    ]);
    expect(() => new serverOnly.InProcessSessionExecutor()).toThrow(
      /server-only.*InProcessSessionExecutor/,
    );
    expect(() => new serverOnly.AgentWorker()).toThrow(
      /server-only.*AgentWorker/,
    );
    expect(() => new serverOnly.EffectDispatcher()).toThrow(
      /server-only.*EffectDispatcher/,
    );
    expect(() => new serverOnly.ExecutionHostSessionRunner()).toThrow(
      /server-only.*ExecutionHostSessionRunner/,
    );
  });

  it('uses distinct server and Node Session factories', async () => {
    const root = await import('../index.js');
    const server = await import('../server/index.js');
    const node = await import('../node/index.js');
    const otel = await import('../server/otel.js');
    const postgres = await import('../server/postgres.js');

    expect(server.createSession).toBe(root.createSession);
    expect(node.createSession).not.toBe(server.createSession);
    expect(server.AgentServer).toBeTypeOf('function');
    expect(server.InProcessSessionExecutor).toBeTypeOf('function');
    expect(server.AgentWorker).toBeTypeOf('function');
    expect(server.EffectDispatcher).toBeTypeOf('function');
    expect(server.SdkSessionRunner).toBeTypeOf('function');
    expect(server.ExecutionHostSessionRunner).toBeTypeOf('function');
    expect('PostgresRuntimeStore' in server).toBe(false);
    expect(postgres.PostgresRuntimeStore).toBeTypeOf('function');
    expect('OpenTelemetryAgentServerTelemetry' in server).toBe(false);
    expect(otel.OpenTelemetryAgentServerTelemetry).toBeTypeOf('function');
    expect(server.EphemeralCredentialBroker).toBeTypeOf('function');
    expect(server.ExecutionHostError).toBeTypeOf('function');
    expect(server.WorkerRuntimeError).toBeTypeOf('function');
    expect(server.RUNTIME_SESSION_STATES).toEqual([
      'queued',
      'provisioning',
      'running',
      'waiting_approval',
      'suspended',
      'idle',
      'completed',
      'failed',
    ]);
    expect(node.JsonlSessionRepository).toBeTypeOf('function');
    expect(node.DockerExecutionHost).toBeTypeOf('function');
    expect(node.EphemeralCredentialBroker).toBe(
      server.EphemeralCredentialBroker,
    );
    expect('getBuiltinTools' in root).toBe(false);
    expect(node.getBuiltinTools).toBeTypeOf('function');
  });

  it('keeps browser-safe source entries away from Node-only and server runtime imports', () => {
    const disallowedPatterns = [
      /node:/,
      /child_process/,
      /undici/,
      /node-pty/,
      /@modelcontextprotocol/,
      /\.\.\/session\/index\.js/,
      /\.\.\/server\//,
      /\.\.\/node\//,
      /\.\.\/tools\/builtin\//,
    ];

    for (const file of [
      'src/core/index.ts',
      'src/browser/index.ts',
      'src/browser/server-only-stub.ts',
      'src/model/index.ts',
    ]) {
      const source = readFileSync(file, 'utf-8');
      for (const pattern of disallowedPatterns) {
        expect(source, `${file} should not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
