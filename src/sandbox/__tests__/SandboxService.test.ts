import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { SandboxService, getSandboxService } from '../SandboxService.js';

const mockSandboxExecutor = {
  configure: mock(() => {}),
  canUseSandbox: mock(() => false),
  buildExecutionOptions: mock(() => ({ workDir: '/test' })),
  wrapCommand: mock((cmd: string) => cmd),
  getCapabilities: mock(() => ({
    available: false,
    type: 'none' as const,
    features: {
      fileSystemIsolation: false,
      networkIsolation: false,
      processIsolation: false,
    },
  })),
};

mock.module('../SandboxExecutor.js', () => ({
  getSandboxExecutor: () => mockSandboxExecutor,
}));

describe('SandboxService', () => {
  beforeEach(() => {
    SandboxService.resetInstance();
  });

  afterEach(() => {
    SandboxService.resetInstance();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = SandboxService.getInstance();
      const instance2 = SandboxService.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should return same instance via getSandboxService helper', () => {
      const instance1 = getSandboxService();
      const instance2 = SandboxService.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('resetInstance', () => {
    it('should create new instance after reset', () => {
      const instance1 = SandboxService.getInstance();
      SandboxService.resetInstance();
      const instance2 = SandboxService.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('configure', () => {
    it('should store settings', () => {
      const service = getSandboxService();
      service.configure({ enabled: true });
      expect(service.getSettings()).toEqual({ enabled: true });
    });

    it('should copy settings to avoid mutation', () => {
      const service = getSandboxService();
      const settings = { enabled: true };
      service.configure(settings);
      settings.enabled = false;
      expect(service.getSettings().enabled).toBe(true);
    });
  });

  describe('isEnabled', () => {
    it('should return false by default', () => {
      const service = getSandboxService();
      expect(service.isEnabled()).toBe(false);
    });

    it('should return true when enabled', () => {
      const service = getSandboxService();
      service.configure({ enabled: true });
      expect(service.isEnabled()).toBe(true);
    });

    it('should return false when explicitly disabled', () => {
      const service = getSandboxService();
      service.configure({ enabled: false });
      expect(service.isEnabled()).toBe(false);
    });
  });

  describe('shouldAutoAllowBash', () => {
    it('should return false when sandbox is disabled', () => {
      const service = getSandboxService();
      service.configure({ enabled: false, autoAllowBashIfSandboxed: true });
      expect(service.shouldAutoAllowBash()).toBe(false);
    });

    it('should return false when autoAllowBashIfSandboxed is false', () => {
      const service = getSandboxService();
      service.configure({ enabled: true, autoAllowBashIfSandboxed: false });
      expect(service.shouldAutoAllowBash()).toBe(false);
    });

    it('should return true when both enabled and autoAllowBashIfSandboxed are true', () => {
      const service = getSandboxService();
      service.configure({ enabled: true, autoAllowBashIfSandboxed: true });
      expect(service.shouldAutoAllowBash()).toBe(true);
    });
  });

  describe('isCommandExcluded', () => {
    it('should return false when no excluded commands', () => {
      const service = getSandboxService();
      service.configure({ enabled: true });
      expect(service.isCommandExcluded('git status')).toBe(false);
    });

    it('should return true for exact match', () => {
      const service = getSandboxService();
      service.configure({ enabled: true, excludedCommands: ['git'] });
      expect(service.isCommandExcluded('git')).toBe(true);
    });

    it('should return true for command with arguments', () => {
      const service = getSandboxService();
      service.configure({ enabled: true, excludedCommands: ['git'] });
      expect(service.isCommandExcluded('git status')).toBe(true);
    });

    it('should return false for partial match', () => {
      const service = getSandboxService();
      service.configure({ enabled: true, excludedCommands: ['git'] });
      expect(service.isCommandExcluded('gitignore')).toBe(false);
    });
  });

  describe('checkCommand', () => {
    it('should allow command when sandbox is disabled', () => {
      const service = getSandboxService();
      service.configure({ enabled: false });
      const result = service.checkCommand({ command: 'rm -rf /' });
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('Sandbox is disabled');
    });

    it('should allow excluded command', () => {
      const service = getSandboxService();
      service.configure({ enabled: true, excludedCommands: ['git'] });
      const result = service.checkCommand({ command: 'git push' });
      expect(result.allowed).toBe(true);
      expect(result.isExcluded).toBe(true);
    });

    it('should block unsandboxed command when not allowed', () => {
      const service = getSandboxService();
      service.configure({ enabled: true, allowUnsandboxedCommands: false });
      const result = service.checkCommand({ command: 'ls', dangerouslyDisableSandbox: true });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Unsandboxed commands are not allowed');
    });

    it('should require permission for unsandboxed command when allowed', () => {
      const service = getSandboxService();
      service.configure({ enabled: true, allowUnsandboxedCommands: true });
      const result = service.checkCommand({ command: 'ls', dangerouslyDisableSandbox: true });
      expect(result.allowed).toBe(false);
      expect(result.requiresPermission).toBe(true);
    });

    it('should allow normal command in sandbox', () => {
      const service = getSandboxService();
      service.configure({ enabled: true });
      const result = service.checkCommand({ command: 'ls -la' });
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('Command will run in sandbox');
    });
  });

  describe('shouldIgnoreFileViolation', () => {
    it('should return false when no ignore patterns', () => {
      const service = getSandboxService();
      service.configure({ enabled: true });
      expect(service.shouldIgnoreFileViolation('/tmp/test')).toBe(false);
    });

    it('should match exact path prefix', () => {
      const service = getSandboxService();
      service.configure({
        enabled: true,
        ignoreViolations: { file: ['/tmp/'] },
      });
      expect(service.shouldIgnoreFileViolation('/tmp/test')).toBe(true);
    });

    it('should match wildcard pattern', () => {
      const service = getSandboxService();
      service.configure({
        enabled: true,
        ignoreViolations: { file: ['/tmp/*'] },
      });
      expect(service.shouldIgnoreFileViolation('/tmp/test')).toBe(true);
    });

    it('should not match unrelated path', () => {
      const service = getSandboxService();
      service.configure({
        enabled: true,
        ignoreViolations: { file: ['/tmp/*'] },
      });
      expect(service.shouldIgnoreFileViolation('/var/test')).toBe(false);
    });
  });

  describe('shouldIgnoreNetworkViolation', () => {
    it('should return false when no ignore patterns', () => {
      const service = getSandboxService();
      service.configure({ enabled: true });
      expect(service.shouldIgnoreNetworkViolation('localhost:8080')).toBe(false);
    });

    it('should match exact target', () => {
      const service = getSandboxService();
      service.configure({
        enabled: true,
        ignoreViolations: { network: ['localhost:8080'] },
      });
      expect(service.shouldIgnoreNetworkViolation('localhost:8080')).toBe(true);
    });

    it('should match wildcard pattern', () => {
      const service = getSandboxService();
      service.configure({
        enabled: true,
        ignoreViolations: { network: ['localhost:*'] },
      });
      expect(service.shouldIgnoreNetworkViolation('localhost:3000')).toBe(true);
    });
  });

  describe('network settings', () => {
    it('should return empty object when no network settings', () => {
      const service = getSandboxService();
      service.configure({ enabled: true });
      expect(service.getNetworkSettings()).toEqual({});
    });

    it('should return network settings', () => {
      const service = getSandboxService();
      service.configure({
        enabled: true,
        network: { allowLocalBinding: true },
      });
      expect(service.getNetworkSettings()).toEqual({ allowLocalBinding: true });
    });

    it('should check allowsLocalBinding', () => {
      const service = getSandboxService();
      service.configure({
        enabled: true,
        network: { allowLocalBinding: true },
      });
      expect(service.allowsLocalBinding()).toBe(true);
    });
  });

  describe('isUnixSocketAllowed', () => {
    it('should return false when no network settings', () => {
      const service = getSandboxService();
      service.configure({ enabled: true });
      expect(service.isUnixSocketAllowed('/var/run/docker.sock')).toBe(false);
    });

    it('should return true when allowAllUnixSockets is true', () => {
      const service = getSandboxService();
      service.configure({
        enabled: true,
        network: { allowAllUnixSockets: true },
      });
      expect(service.isUnixSocketAllowed('/var/run/docker.sock')).toBe(true);
    });

    it('should return true for allowed socket path', () => {
      const service = getSandboxService();
      service.configure({
        enabled: true,
        network: { allowUnixSockets: ['/var/run/docker.sock'] },
      });
      expect(service.isUnixSocketAllowed('/var/run/docker.sock')).toBe(true);
    });

    it('should return false for non-allowed socket path', () => {
      const service = getSandboxService();
      service.configure({
        enabled: true,
        network: { allowUnixSockets: ['/var/run/docker.sock'] },
      });
      expect(service.isUnixSocketAllowed('/var/run/other.sock')).toBe(false);
    });
  });

  describe('wrapCommandForSandbox', () => {
    it('should return original command when sandbox is disabled', () => {
      const service = getSandboxService();
      service.configure({ enabled: false });
      const result = service.wrapCommandForSandbox('ls -la');
      expect(result).toBe('ls -la');
    });
  });
});
