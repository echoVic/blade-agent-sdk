import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bashTool } from '../../tools/builtin/shell/bash.js';
import type { SandboxCapabilities } from '../SandboxExecutor.js';
import { getSandboxService, SandboxService } from '../SandboxService.js';

const availableCapabilities: SandboxCapabilities = {
  available: true,
  type: 'seatbelt',
  features: {
    fileSystemIsolation: true,
    networkIsolation: true,
    processIsolation: true,
  },
};

const mockSandboxExecutor = {
  canUseSandbox: vi.fn(() => true),
  buildExecutionOptions: vi.fn(() => ({ workDir: '/test' })),
  // Mirrors the real contract: a disabled policy means the command is not wrapped.
  wrapCommand: vi.fn((cmd: string, _options: unknown, settings?: { enabled?: boolean }) =>
    settings?.enabled === false ? cmd : `sandbox:${cmd}`),
  getCapabilities: vi.fn((): SandboxCapabilities => availableCapabilities),
};

vi.mock('../SandboxExecutor.js', () => ({
  getSandboxExecutor: () => mockSandboxExecutor,
}));

describe('SandboxService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSandboxExecutor.canUseSandbox.mockReturnValue(true);
    mockSandboxExecutor.getCapabilities.mockReturnValue(availableCapabilities);
    mockSandboxExecutor.wrapCommand.mockImplementation(
      (cmd: string, _options: unknown, settings?: { enabled?: boolean }) =>
        settings?.enabled === false ? cmd : `sandbox:${cmd}`,
    );
    SandboxService.resetInstance();
  });

  afterEach(() => {
    SandboxService.resetInstance();
  });

  describe('instance', () => {
    it('is a singleton with a reset hook for tests', () => {
      const first = SandboxService.getInstance();
      expect(getSandboxService()).toBe(first);
      SandboxService.resetInstance();
      expect(SandboxService.getInstance()).not.toBe(first);
    });
  });

  describe('policy ownership', () => {
    it('decides from the settings passed in, never from stored state', () => {
      const service = getSandboxService();
      expect(service.isEnabled({})).toBe(false);
      expect(service.isEnabled({ enabled: true })).toBe(true);
      // Nothing was retained, so the next unrelated call is unaffected.
      expect(service.isEnabled({})).toBe(false);
    });

    it('keeps two Sessions with different policies isolated', () => {
      const service = getSandboxService();
      const sessionA = { enabled: true, allowUnsandboxedCommands: false };
      const sessionB = { enabled: true, allowUnsandboxedCommands: true };

      expect(service.allowsUnsandboxedCommands(sessionA)).toBe(false);
      expect(service.checkCommand({ command: 'ls', dangerouslyDisableSandbox: true }, sessionA))
        .toMatchObject({ outcome: 'denied' });
      // Reading B's policy must not change what A observes.
      expect(service.allowsUnsandboxedCommands(sessionB)).toBe(true);
      expect(service.checkCommand({ command: 'ls', dangerouslyDisableSandbox: true }, sessionA))
        .toMatchObject({ outcome: 'denied' });
    });

    it('returns copies so a caller cannot mutate the policy it passed in', () => {
      const service = getSandboxService();
      const settings = { enabled: true, excludedCommands: ['git'] };
      const copy = service.getSettings(settings);
      copy.excludedCommands?.push('rm');
      expect(settings.excludedCommands).toEqual(['git']);
      expect(copy.excludedCommands).toEqual(['git', 'rm']);
    });

    it('fails closed when an enabled policy has no usable platform sandbox', () => {
      const service = getSandboxService();
      mockSandboxExecutor.getCapabilities.mockReturnValue({
        available: false,
        type: 'none',
        features: {
          fileSystemIsolation: false,
          networkIsolation: false,
          processIsolation: false,
        },
      });

      expect(() => service.assertUsable({ enabled: true })).toThrow(
        'Sandbox is enabled, but no supported sandbox executor is available',
      );
      // A disabled policy needs no platform support.
      expect(() => service.assertUsable({ enabled: false })).not.toThrow();
    });
  });

  describe('shouldAutoAllowBash', () => {
    it('requires an enabled policy, the opt-in flag, and platform support', () => {
      const service = getSandboxService();
      expect(service.shouldAutoAllowBash({ enabled: false, autoAllowBashIfSandboxed: true }))
        .toBe(false);
      expect(service.shouldAutoAllowBash({ enabled: true, autoAllowBashIfSandboxed: false }))
        .toBe(false);
      expect(service.shouldAutoAllowBash({ enabled: true, autoAllowBashIfSandboxed: true }))
        .toBe(true);

      mockSandboxExecutor.canUseSandbox.mockReturnValue(false);
      expect(service.shouldAutoAllowBash({ enabled: true, autoAllowBashIfSandboxed: true }))
        .toBe(false);
    });
  });

  describe('isCommandExcluded', () => {
    it('matches the command name exactly or with arguments', () => {
      const service = getSandboxService();
      const settings = { enabled: true, excludedCommands: ['git'] };
      expect(service.isCommandExcluded('git', settings)).toBe(true);
      expect(service.isCommandExcluded('git status', settings)).toBe(true);
      expect(service.isCommandExcluded('gitlab status', settings)).toBe(false);
      expect(service.isCommandExcluded('git status', { enabled: true })).toBe(false);
    });
  });

  describe('checkCommand', () => {
    it('reports the policy outcome for each case', () => {
      const service = getSandboxService();
      expect(service.checkCommand({ command: 'ls' }, { enabled: false }))
        .toMatchObject({ outcome: 'disabled' });
      expect(service.checkCommand({ command: 'git status' }, {
        enabled: true, excludedCommands: ['git'],
      })).toMatchObject({ outcome: 'excluded' });
      expect(service.checkCommand({ command: 'ls' }, { enabled: true }))
        .toMatchObject({ outcome: 'sandboxed' });

      const unsandboxed = { command: 'ls', dangerouslyDisableSandbox: true } as const;
      expect(service.checkCommand(unsandboxed, { enabled: true }))
        .toMatchObject({ outcome: 'denied' });
      expect(service.checkCommand(unsandboxed, { enabled: true, allowUnsandboxedCommands: true }))
        .toMatchObject({ outcome: 'requires_permission' });

      mockSandboxExecutor.canUseSandbox.mockReturnValue(false);
      expect(service.checkCommand({ command: 'ls' }, { enabled: true }))
        .toMatchObject({ outcome: 'unavailable' });
    });
  });

  describe('network policy', () => {
    it('reads unix socket and local binding rules from the given settings', () => {
      const service = getSandboxService();
      expect(service.getNetworkSettings({})).toEqual({});
      expect(service.allowsLocalBinding({ network: { allowLocalBinding: true } })).toBe(true);
      expect(service.allowsLocalBinding({})).toBe(false);
      expect(service.isUnixSocketAllowed('/var/run/docker.sock', {})).toBe(false);
      expect(service.isUnixSocketAllowed('/var/run/docker.sock', {
        network: { allowAllUnixSockets: true },
      })).toBe(true);
      expect(service.isUnixSocketAllowed('/var/run/docker.sock', {
        network: { allowUnixSockets: ['/var/run/docker.sock'] },
      })).toBe(true);
      expect(service.isUnixSocketAllowed('/var/run/other.sock', {
        network: { allowUnixSockets: ['/var/run/docker.sock'] },
      })).toBe(false);
    });
  });

  describe('wrapCommandForSandbox', () => {
    it('returns the command unchanged when the policy is disabled or excluded', () => {
      const service = getSandboxService();
      expect(service.wrapCommandForSandbox('ls -la', '/tmp', { enabled: false })).toBe('ls -la');
      expect(service.wrapCommandForSandbox('git status', '/tmp', {
        enabled: true, excludedCommands: ['git'],
      })).toBe('git status');

      // The executor owns the decision: an excluded command reaches it as a
      // disabled policy rather than being short-circuited here.
      expect(mockSandboxExecutor.wrapCommand).toHaveBeenLastCalledWith(
        'git status',
        expect.anything(),
        expect.objectContaining({ enabled: false }),
      );
    });

    it('delegates to the executor together with the given policy', () => {
      const service = getSandboxService();
      expect(service.wrapCommandForSandbox('ls -la', '/tmp', { enabled: true }))
        .toBe('sandbox:ls -la');
      // The executor builds the options from the policy's network facet, and the
      // wrapping call carries the same policy.
      expect(mockSandboxExecutor.buildExecutionOptions).toHaveBeenCalledWith('/tmp', undefined);
      expect(mockSandboxExecutor.wrapCommand).toHaveBeenCalledWith(
        'ls -la',
        expect.anything(),
        expect.objectContaining({ enabled: true }),
      );
    });
  });

  describe('Bash integration', () => {
    function snapshotWith(sandbox: unknown) {
      return {
        contextSnapshot: {
          sessionId: 'session-bash',
          turnId: 'turn-bash',
          context: {},
          filesystemRoots: ['/tmp'],
          cwd: '/tmp',
          environment: {},
          sandbox,
        },
      } as never;
    }

    it('denies Bash before execution when the policy needs an unavailable sandbox', async () => {
      mockSandboxExecutor.canUseSandbox.mockReturnValue(false);

      const result = await bashTool.checkPermissions?.(
        { command: 'echo unsafe', timeout: 30_000, run_in_background: false },
        snapshotWith({ enabled: true }),
      );

      expect(result).toEqual({
        behavior: 'deny',
        message: expect.stringContaining(
          'Sandbox is enabled, but no supported sandbox executor is available',
        ),
      });
    });

    it('reads the policy from the execution context instead of a global', async () => {
      // A context without a policy must not inherit another Session's sandbox.
      const withoutPolicy = await bashTool.checkPermissions?.(
        { command: 'echo hi', timeout: 30_000, run_in_background: false },
        snapshotWith(undefined),
      );
      expect(withoutPolicy).toBeUndefined();

      // Two Sessions, two policies, evaluated in the same process.
      const deniedForA = await bashTool.checkPermissions?.(
        { command: 'echo hi', timeout: 30_000, run_in_background: false },
        snapshotWith({ enabled: true, allowUnsandboxedCommands: false }),
      );
      const allowedForB = await bashTool.checkPermissions?.(
        { command: 'echo hi', timeout: 30_000, run_in_background: false },
        snapshotWith({ enabled: true, allowUnsandboxedCommands: true }),
      );
      expect(deniedForA).toBeUndefined();
      expect(allowedForB).toBeUndefined();

      // The unsandboxed branch is a policy decision, checked on the service.
      const service = getSandboxService();
      const unsandboxed = { command: 'echo hi', dangerouslyDisableSandbox: true };
      expect(service.checkCommand(unsandboxed, { enabled: true }))
        .toMatchObject({ outcome: 'denied' });
      expect(service.checkCommand(unsandboxed, { enabled: true, allowUnsandboxedCommands: true }))
        .toMatchObject({ outcome: 'requires_permission' });
    });
  });
});
