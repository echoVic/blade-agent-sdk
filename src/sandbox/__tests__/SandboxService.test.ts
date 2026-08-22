import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bashTool } from '../../tools/builtin/shell/bash.js';
import type { SandboxCapabilities } from '../SandboxExecutor.js';
import { getSandboxService, SandboxService } from '../SandboxService.js';

const mockSandboxExecutor = {
  configure: vi.fn(() => {}),
  canUseSandbox: vi.fn(() => true),
  buildExecutionOptions: vi.fn(() => ({ workDir: '/test' })),
  wrapCommand: vi.fn((cmd: string) => `sandbox:${cmd}`),
  getCapabilities: vi.fn(
    (): SandboxCapabilities => ({
      available: true,
      type: 'seatbelt' as const,
      features: {
        fileSystemIsolation: true,
        networkIsolation: true,
        processIsolation: true,
      },
    }),
  ),
};

vi.mock('../SandboxExecutor.js', () => ({
  getSandboxExecutor: () => mockSandboxExecutor,
}));

describe('SandboxService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandboxExecutor.canUseSandbox.mockReturnValue(true);
    mockSandboxExecutor.getCapabilities.mockReturnValue({
      available: true,
      type: 'seatbelt',
      features: {
        fileSystemIsolation: true,
        networkIsolation: true,
        processIsolation: true,
      },
    });
    mockSandboxExecutor.wrapCommand.mockImplementation((cmd: string) => `sandbox:${cmd}`);
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

    it('should fail when sandbox is enabled without an available executor', () => {
      mockSandboxExecutor.getCapabilities.mockReturnValue({
        available: false,
        type: 'none',
        features: {
          fileSystemIsolation: false,
          networkIsolation: false,
          processIsolation: false,
        },
      });
      const service = getSandboxService();

      expect(() => service.configure({ enabled: true })).toThrow(
        'Sandbox is enabled, but no supported sandbox executor is available',
      );
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

    it('should return false when the configured sandbox becomes unavailable', () => {
      const service = getSandboxService();
      service.configure({ enabled: true, autoAllowBashIfSandboxed: true });
      mockSandboxExecutor.canUseSandbox.mockReturnValue(false);

      expect(service.shouldAutoAllowBash()).toBe(false);
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
      expect(result.outcome).toBe('disabled');
      expect(result.reason).toBe('Sandbox is disabled');
    });

    it('should allow excluded command', () => {
      const service = getSandboxService();
      service.configure({ enabled: true, excludedCommands: ['git'] });
      const result = service.checkCommand({ command: 'git push' });
      expect(result.outcome).toBe('excluded');
    });

    it('should block unsandboxed command when not allowed', () => {
      const service = getSandboxService();
      service.configure({ enabled: true, allowUnsandboxedCommands: false });
      const result = service.checkCommand({ command: 'ls', dangerouslyDisableSandbox: true });
      expect(result.outcome).toBe('denied');
      expect(result.reason).toBe('Unsandboxed commands are not allowed');
    });

    it('should require permission for unsandboxed command when allowed', () => {
      const service = getSandboxService();
      service.configure({ enabled: true, allowUnsandboxedCommands: true });
      const result = service.checkCommand({ command: 'ls', dangerouslyDisableSandbox: true });
      expect(result.outcome).toBe('requires_permission');
    });

    it('should allow normal command in sandbox', () => {
      const service = getSandboxService();
      service.configure({ enabled: true });
      const result = service.checkCommand({ command: 'ls -la' });
      expect(result.outcome).toBe('sandboxed');
      expect(result.reason).toBe('Command will run in sandbox');
    });

    it('should deny a normal command when the configured sandbox becomes unavailable', () => {
      const service = getSandboxService();
      service.configure({ enabled: true });
      mockSandboxExecutor.canUseSandbox.mockReturnValue(false);

      const result = service.checkCommand({ command: 'ls -la' });

      expect(result.outcome).toBe('unavailable');
      expect(result.reason).toContain(
        'Sandbox is enabled, but no supported sandbox executor is available',
      );
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
      const result = service.wrapCommandForSandbox('ls -la', '/tmp');
      expect(result).toBe('ls -la');
    });

    it('should use the configured executor when sandbox is enabled', () => {
      const service = getSandboxService();
      service.configure({ enabled: true });

      expect(service.wrapCommandForSandbox('ls -la', '/tmp')).toBe('sandbox:ls -la');
    });

    it('should leave explicitly excluded commands unsandboxed', () => {
      const service = getSandboxService();
      service.configure({ enabled: true, excludedCommands: ['git'] });

      expect(service.wrapCommandForSandbox('git status', '/tmp')).toBe('git status');
      expect(mockSandboxExecutor.wrapCommand).not.toHaveBeenCalled();
    });
  });

  describe('Bash integration', () => {
    it('should deny Bash before execution when the sandbox is unavailable', async () => {
      const service = getSandboxService();
      service.configure({ enabled: true });
      mockSandboxExecutor.canUseSandbox.mockReturnValue(false);

      const result = await bashTool.checkPermissions?.(
        {
          command: 'echo unsafe',
          timeout: 30_000,
          run_in_background: false,
        },
        {},
      );

      expect(result).toEqual({
        behavior: 'deny',
        message: expect.stringContaining(
          'Sandbox is enabled, but no supported sandbox executor is available',
        ),
      });
    });
  });
});
