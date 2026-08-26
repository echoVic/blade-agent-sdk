import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const goldenPaths = [
  'examples/local-cli-agent/index.mjs',
  'examples/web-agent-server/server.mjs',
  'examples/web-agent-server/client.js',
  'examples/web-agent-server/index.html',
  'examples/postgres-worker-recovery/compose.yaml',
  'examples/postgres-worker-recovery/run.mjs',
  'examples/postgres-worker-recovery/worker.mjs',
  'examples/production-stack/compose.yaml',
  'examples/production-stack/DockerPromptRunner.mjs',
  'examples/production-stack/QueuedSessionExecutor.mjs',
  'examples/production-stack/run.mjs',
] as const;

describe('golden paths', () => {
  it('keeps every runnable entrypoint wired to package scripts', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts).toMatchObject({
      'example:local':
        'pnpm run build && node examples/local-cli-agent/index.mjs',
      'example:production':
        'pnpm run build && node examples/production-stack/run.mjs',
      'example:web':
        'pnpm run build && node examples/web-agent-server/server.mjs',
      'example:worker-recovery':
        'pnpm run build && node examples/postgres-worker-recovery/run.mjs',
    });
    for (const file of goldenPaths) {
      expect(existsSync(resolve(file)), file).toBe(true);
    }
  });

  it('uses only public package entrypoints', () => {
    for (const file of goldenPaths.filter((path) => path.endsWith('.mjs'))) {
      const source = readFileSync(resolve(file), 'utf8');
      expect(source, file).not.toMatch(/from ['"].*(?:\/src\/|\.\.\/\.\.\/src)/);
    }
  });

  it('exercises the intended runtime boundaries', () => {
    expect(
      readFileSync(resolve('examples/local-cli-agent/index.mjs'), 'utf8'),
    ).toContain('@blade-ai/agent-sdk/node');
    expect(
      readFileSync(resolve('examples/web-agent-server/client.js'), 'utf8'),
    ).toContain('@blade-ai/agent-sdk/browser');
    expect(
      readFileSync(resolve('examples/web-agent-server/server.mjs'), 'utf8'),
    ).toContain('@blade-ai/agent-sdk/server');
    const worker = readFileSync(
      resolve('examples/postgres-worker-recovery/worker.mjs'),
      'utf8',
    );
    expect(worker).toContain('AgentWorker');
    expect(worker).toContain('ExecutionHostSessionRunner');
    expect(worker).toContain('DockerExecutionHost');

    const production = readFileSync(
      resolve('examples/production-stack/run.mjs'),
      'utf8',
    );
    for (const boundary of [
      'AgentClient',
      'AgentServer',
      'PostgresRuntimeStore',
      'AgentWorker',
      'DockerExecutionHost',
    ]) {
      expect(production).toContain(boundary);
    }
  });

  it('keeps the Web example in standards mode without external assets', () => {
    const html = readFileSync(
      resolve('examples/web-agent-server/index.html'),
      'utf8',
    );
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/(?:src|href)=["']https?:\/\//);
  });
});
