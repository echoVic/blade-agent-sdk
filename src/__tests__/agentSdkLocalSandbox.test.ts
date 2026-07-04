import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getSandboxExecutor,
  getSandboxService,
  SandboxExecutor,
  SandboxService,
} from '../../packages/agent-sdk/src/local/sandbox.js';

describe('agent-sdk local sandbox adapter', () => {
  beforeEach(() => {
    SandboxExecutor.resetInstance();
    SandboxService.resetInstance();
  });

  afterEach(() => {
    SandboxExecutor.resetInstance();
    SandboxService.resetInstance();
  });

  it('owns sandbox singleton runtime inside the package-local adapter', () => {
    const executor = getSandboxExecutor();
    const service = getSandboxService();

    expect(executor).toBe(SandboxExecutor.getInstance());
    expect(service).toBe(SandboxService.getInstance());

    service.configure({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: true,
      excludedCommands: ['git'],
      network: {
        allowLocalBinding: false,
        allowUnixSockets: ['/var/run/docker.sock'],
      },
    });

    expect(service.getSettings()).toMatchObject({
      enabled: true,
      autoAllowBashIfSandboxed: true,
    });
    expect(service.shouldAutoAllowBash()).toBe(true);
    expect(service.isCommandExcluded('git status')).toBe(true);
    expect(service.checkCommand({ command: 'git status' })).toMatchObject({
      allowed: true,
      isExcluded: true,
    });
    expect(service.checkCommand({ command: 'ls', dangerouslyDisableSandbox: true })).toMatchObject(
      {
        allowed: false,
        requiresPermission: true,
      },
    );
    expect(service.isUnixSocketAllowed('/var/run/docker.sock')).toBe(true);
    expect(executor.isEnabled()).toBe(true);
    expect(executor.buildExecutionOptions('/tmp/project', service.getNetworkSettings()))
      .toMatchObject({
        workDir: '/tmp/project',
        allowNetwork: false,
      });
  });

  it('keeps disabled sandbox wrapping as a no-op', () => {
    const executor = getSandboxExecutor();
    const service = getSandboxService();

    executor.configure({ enabled: false });
    service.configure({ enabled: false });

    expect(executor.wrapCommand('echo ok', { workDir: '/tmp/project' })).toBe('echo ok');
    expect(service.wrapCommandForSandbox('echo ok', '/tmp/project')).toBe('echo ok');
    expect(service.getCapabilities()).toHaveProperty('features.fileSystemIsolation');
  });
});
