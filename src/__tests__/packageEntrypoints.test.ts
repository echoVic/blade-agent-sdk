import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync('package.json', 'utf-8')) as {
  exports: Record<string, unknown>;
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
    });
  });

  it('has source modules for every public subpath entry', () => {
    for (const file of [
      'src/core/index.ts',
      'src/browser/index.ts',
      'src/browser/server-only-stub.ts',
      'src/protocol/index.ts',
      'src/server/index.ts',
      'src/tools/index.ts',
      'src/node/index.ts',
      'src/middleware/index.ts',
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
    expect(browser.AgentClient).toBeTypeOf('function');
    expect(browser.AGENT_PROTOCOL_VERSION).toBe(1);
    expect(() => browser.createSession({} as never)).toThrow(/server-only.*createSession/);
    expect(() => serverOnly.getBuiltinTools()).toThrow(/server-only.*getBuiltinTools/);
    expect(() => new serverOnly.JsonlDurableEventStore()).toThrow(
      /server-only.*JsonlDurableEventStore/,
    );
    expect(() => new serverOnly.AgentServer()).toThrow(/server-only.*AgentServer/);
    expect(() => new serverOnly.InProcessSessionExecutor()).toThrow(
      /server-only.*InProcessSessionExecutor/,
    );
  });

  it('uses distinct server and Node Session factories', async () => {
    const root = await import('../index.js');
    const server = await import('../server/index.js');
    const node = await import('../node/index.js');

    expect(server.createSession).toBe(root.createSession);
    expect(node.createSession).not.toBe(server.createSession);
    expect(server.AgentServer).toBeTypeOf('function');
    expect(server.InProcessSessionExecutor).toBeTypeOf('function');
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
