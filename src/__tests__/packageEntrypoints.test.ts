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
  it('declares only canonical and server-specialized entrypoints', () => {
    expect(Object.keys(packageJson.exports).sort()).toEqual(
      [
        '.',
        './advanced',
        './browser',
        './package.json',
        './protocol',
        './server/infra',
        './server/postgres',
      ].sort(),
    );
    expect(packageJson.exports).toMatchObject({
      '.': {
        types: './dist/index.d.ts',
        browser: './dist/browser/index.js',
        import: './dist/index.js',
      },
      './advanced': {
        types: './dist/advanced/index.d.ts',
        browser: './dist/browser/server-only-stub.js',
        import: './dist/advanced/index.js',
      },
      './browser': {
        types: './dist/browser/index.d.ts',
        import: './dist/browser/index.js',
      },
      './protocol': {
        types: './dist/protocol/index.d.ts',
        import: './dist/protocol/index.js',
      },
      './server/infra': {
        types: './dist/server/infra.d.ts',
        browser: './dist/browser/server-only-stub.js',
        import: './dist/server/infra.js',
      },
      './server/postgres': {
        types: './dist/server/postgres.d.ts',
        browser: './dist/browser/server-only-stub.js',
        import: './dist/server/postgres.js',
      },
    });
  });

  it('has source modules for every public subpath entry', () => {
    for (const file of [
      'src/advanced/index.ts',
      'src/core/index.ts',
      'src/browser/index.ts',
      'src/browser/server-only-stub.ts',
      'src/protocol/index.ts',
      'src/server/infra.ts',
      'src/server/postgres.ts',
      'src/node/index.ts',
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
      'create-blade-agent': 'dist/cli/create-blade-agent.js',
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
    expect(browser.defineTool).toBeTypeOf('function');
    expect(browser.DurableEventType.REQUEST_ACCEPTED).toBe('request_accepted');
    expect(browser.DurableSessionJournal.open).toBeTypeOf('function');
    expect(browser.DurableSessionRecoveryRequiredError).toBeDefined();
    expect(browser.projectDurableSession([]).status).toBe('empty');
    expect(browser.PermissionRequestId('permission-1')).toBe('permission-1');
    expect(browser.ToolUseId('tool-call-1')).toBe('tool-call-1');
    expect(browser.ExecutionId('execution-1')).toBe('execution-1');
    expect(browser.ExecutionCheckpointId('checkpoint-1')).toBe('checkpoint-1');
    expect('CredentialLeaseId' in browser).toBe(false);
    expect(browser.AgentClient).toBeTypeOf('function');
    expect(browser.AgentResponse).toBeTypeOf('function');
    expect(browser.AGENT_PROTOCOL_VERSION).toBe(1);
    expect(() => browser.createAgent({} as never)).toThrow(/server-only.*createAgent/);
    expect(() => browser.createSession({} as never)).toThrow(/server-only.*createSession/);
    expect(() => serverOnly.createNodeSession({} as never)).toThrow(
      /server-only.*createNodeSession/,
    );
    expect(() => serverOnly.createServerSession({} as never)).toThrow(
      /server-only.*createServerSession/,
    );
    expect(() => serverOnly.getBuiltinTools()).toThrow(/server-only.*getBuiltinTools/);
    expect(() => new serverOnly.JsonlDurableEventStore()).toThrow(
      /server-only.*JsonlDurableEventStore/,
    );
    expect(() => new serverOnly.AgentServer()).toThrow(/server-only.*AgentServer/);
    expect(() => new serverOnly.PostgresRuntimeStore()).toThrow(
      /server-only.*PostgresRuntimeStore/,
    );
    expect('EphemeralCredentialBroker' in serverOnly).toBe(false);
    expect(() => new serverOnly.ExecutionHostError()).toThrow(/server-only.*ExecutionHostError/);
    expect(() => new serverOnly.WorkerRuntimeError()).toThrow(/server-only.*WorkerRuntimeError/);
    expect(serverOnly.RUNTIME_STORE_SCHEMA_VERSION).toBe(5);
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
    expect(() => new serverOnly.AgentWorker()).toThrow(/server-only.*AgentWorker/);
    expect(() => new serverOnly.ExecutionHostSessionRunner()).toThrow(
      /server-only.*ExecutionHostSessionRunner/,
    );
  });

  it('uses distinct server and local Session factories', async () => {
    const root = await import('../index.js');
    const advanced = await import('../advanced/index.js');
    const infra = await import('../server/infra.js');
    const node = await import('../node/index.js');
    const postgres = await import('../server/postgres.js');

    expect(root.createAgent).toBeTypeOf('function');
    expect(advanced.createSession).toBe(node.createSession);
    expect(advanced.createNodeSession).toBe(node.createSession);
    expect(advanced.createServerSession).toBe(root.createSession);
    expect(infra.AgentServer).toBeTypeOf('function');
    expect(infra.AgentWorker).toBeTypeOf('function');
    expect(postgres.PostgresRuntimeStore).toBeTypeOf('function');
    expect('createAgent' in infra).toBe(false);
    expect('createSession' in infra).toBe(false);
    expect('EffectDispatcher' in infra).toBe(false);
    expect('PostgresRuntimeStore' in infra).toBe(false);
    expect('OpenTelemetryAgentServerTelemetry' in infra).toBe(false);
    expect(node.createAgent).toBe(root.createAgent);
    expect(node.createSession).not.toBe(root.createSession);
    expect(infra.InProcessSessionExecutor).toBeTypeOf('function');
    expect(advanced.SdkSessionRunner).toBeTypeOf('function');
    expect(advanced.ExecutionHostSessionRunner).toBeTypeOf('function');
    expect('EphemeralCredentialBroker' in advanced).toBe(false);
    expect(advanced.ExecutionHostError).toBeTypeOf('function');
    expect(infra.WorkerRuntimeError).toBeTypeOf('function');
    expect(infra.RUNTIME_SESSION_STATES).toEqual([
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
    ]) {
      const source = readFileSync(file, 'utf-8');
      for (const pattern of disallowedPatterns) {
        expect(source, `${file} should not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
