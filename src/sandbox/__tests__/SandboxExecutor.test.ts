import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InternalLogger } from '../../logging/Logger.js';
import { getSandboxExecutor, SandboxExecutor } from '../SandboxExecutor.js';

describe('SandboxExecutor', () => {
  beforeEach(() => {
    SandboxExecutor.resetInstance();
  });

  afterEach(() => {
    SandboxExecutor.resetInstance();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = SandboxExecutor.getInstance();
      const instance2 = SandboxExecutor.getInstance();
      expect(instance1).toBe(instance2);
    });

    it('should return same instance via getSandboxExecutor helper', () => {
      const instance1 = getSandboxExecutor();
      const instance2 = SandboxExecutor.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('resetInstance', () => {
    it('should create new instance after reset', () => {
      const instance1 = SandboxExecutor.getInstance();
      SandboxExecutor.resetInstance();
      const instance2 = SandboxExecutor.getInstance();
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('isEnabled', () => {
    it('reads the policy it is given, not process state', () => {
      const executor = getSandboxExecutor();
      expect(executor.isEnabled({})).toBe(false);
      expect(executor.isEnabled({ enabled: true })).toBe(true);
      // Nothing is remembered between calls: one process serves many Sessions.
      expect(executor.isEnabled({})).toBe(false);
    });

    it('keeps two policies independent inside one process', () => {
      const executor = getSandboxExecutor();
      const sessionA = { enabled: true, allowUnsandboxedCommands: false };
      const sessionB = { enabled: true, allowUnsandboxedCommands: true };
      expect(executor.isEnabled(sessionA)).toBe(true);
      expect(executor.isEnabled(sessionB)).toBe(true);
      expect(executor.isEnabled(sessionA)).toBe(true);
    });
  });

  describe('getCapabilities', () => {
    it('should return capabilities object', () => {
      const executor = getSandboxExecutor();
      const capabilities = executor.getCapabilities();
      expect(capabilities).toHaveProperty('available');
      expect(capabilities).toHaveProperty('type');
      expect(capabilities).toHaveProperty('features');
    });

    it('should cache capabilities', () => {
      const executor = getSandboxExecutor();
      const cap1 = executor.getCapabilities();
      const cap2 = executor.getCapabilities();
      expect(cap1).toBe(cap2);
    });

    it('should have correct feature structure', () => {
      const executor = getSandboxExecutor();
      const capabilities = executor.getCapabilities();
      expect(capabilities.features).toHaveProperty('fileSystemIsolation');
      expect(capabilities.features).toHaveProperty('networkIsolation');
      expect(capabilities.features).toHaveProperty('processIsolation');
    });
  });

  describe('canUseSandbox', () => {
    it('should return false when the policy is disabled', () => {
      const executor = getSandboxExecutor();
      expect(executor.canUseSandbox({ enabled: false })).toBe(false);
    });

    it('needs both an enabled policy and platform support', () => {
      const executor = getSandboxExecutor();
      // Platform capability is the shared fact; the policy is the caller's.
      expect(executor.canUseSandbox({ enabled: true })).toBe(executor.getCapabilities().available);
    });
  });

  describe('wrapCommand', () => {
    it('should return original command when the policy is disabled', () => {
      const executor = getSandboxExecutor();
      const result = executor.wrapCommand('ls -la', { workDir: '/home/test' }, { enabled: false });
      expect(result).toBe('ls -la');
    });

    it('should fail closed when sandbox is enabled but unavailable', () => {
      const executor = getSandboxExecutor();
      vi.spyOn(executor, 'getCapabilities').mockReturnValue({
        available: false,
        type: 'none',
        features: {
          fileSystemIsolation: false,
          networkIsolation: false,
          processIsolation: false,
        },
      });

      expect(() =>
        executor.wrapCommand('echo unsafe', { workDir: '/home/test' }, { enabled: true }),
      ).toThrow('Sandbox is enabled, but no supported sandbox executor is available');
    });

    it('lets sandboxed processes read the filesystem root on macOS', () => {
      const executor = getSandboxExecutor();
      vi.spyOn(executor, 'getCapabilities').mockReturnValue({
        available: true,
        type: 'seatbelt',
        version: 'macOS built-in',
        features: {
          fileSystemIsolation: true,
          networkIsolation: true,
          processIsolation: true,
        },
      });

      const wrapped = executor.wrapCommand('echo ok', { workDir: '/home/test' }, { enabled: true });
      const profilePath = /-f '([^']+)'/.exec(wrapped)?.[1];
      expect(profilePath).toBeDefined();
      const profile = readFileSync(profilePath as string, 'utf8');
      rmSync(dirname(profilePath as string), { recursive: true, force: true });

      expect(profile).toContain('(allow file-read* (literal "/"))');
    });

    it('covers both a symlinked workDir and its real path, so a sandboxed process is not denied by its own resolved cwd', () => {
      const executor = getSandboxExecutor();
      vi.spyOn(executor, 'getCapabilities').mockReturnValue({
        available: true,
        type: 'seatbelt',
        version: 'macOS built-in',
        features: {
          fileSystemIsolation: true,
          networkIsolation: true,
          processIsolation: true,
        },
      });

      const base = mkdtempSync(join(tmpdir(), 'sandbox-symlink-'));
      const realDir = join(base, 'real');
      mkdirSync(realDir);
      const symlinkedWorkDir = join(base, 'link');
      symlinkSync(realDir, symlinkedWorkDir);

      try {
        const realWorkDir = realpathSync(symlinkedWorkDir);
        const wrapped = executor.wrapCommand(
          'echo ok',
          { workDir: symlinkedWorkDir },
          { enabled: true },
        );
        const profilePath = /-f '([^']+)'/.exec(wrapped)?.[1];
        expect(profilePath).toBeDefined();
        const profile = readFileSync(profilePath as string, 'utf8');
        rmSync(dirname(profilePath as string), { recursive: true, force: true });

        expect(profile).toContain(`(allow file-read* (subpath "${symlinkedWorkDir}"))`);
        expect(profile).toContain(`(allow file-write* (subpath "${symlinkedWorkDir}"))`);
        expect(profile).toContain(`(allow file-read* (subpath "${realWorkDir}"))`);
        expect(profile).toContain(`(allow file-write* (subpath "${realWorkDir}"))`);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('does not throw for a workDir that does not exist, and still covers it', () => {
      const executor = getSandboxExecutor();
      vi.spyOn(executor, 'getCapabilities').mockReturnValue({
        available: true,
        type: 'seatbelt',
        version: 'macOS built-in',
        features: {
          fileSystemIsolation: true,
          networkIsolation: true,
          processIsolation: true,
        },
      });

      const base = mkdtempSync(join(tmpdir(), 'sandbox-missing-'));
      const missingWorkDir = join(base, 'does-not-exist');

      try {
        let wrapped: string | undefined;
        expect(() => {
          wrapped = executor.wrapCommand('echo ok', { workDir: missingWorkDir }, { enabled: true });
        }).not.toThrow();

        const profilePath = /-f '([^']+)'/.exec(wrapped as string)?.[1];
        expect(profilePath).toBeDefined();
        const profile = readFileSync(profilePath as string, 'utf8');
        rmSync(dirname(profilePath as string), { recursive: true, force: true });

        expect(profile).toContain(`(allow file-read* (subpath "${missingWorkDir}"))`);
        expect(profile).toContain(`(allow file-write* (subpath "${missingWorkDir}"))`);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('leaves an allowed read or write path that crosses a symlink unresolved, so only its literal rule is granted', () => {
      const executor = getSandboxExecutor();
      vi.spyOn(executor, 'getCapabilities').mockReturnValue({
        available: true,
        type: 'seatbelt',
        version: 'macOS built-in',
        features: {
          fileSystemIsolation: true,
          networkIsolation: true,
          processIsolation: true,
        },
      });

      const base = mkdtempSync(join(tmpdir(), 'sandbox-allowed-symlink-'));
      const workDir = join(base, 'work');
      mkdirSync(workDir);
      const realAllowed = join(base, 'real-allowed');
      mkdirSync(realAllowed);
      const symlinkedAllowed = join(base, 'linked-allowed');
      symlinkSync(realAllowed, symlinkedAllowed);

      try {
        // Confirms the fixture actually crosses a symlink; otherwise the
        // "not resolved" assertion below would pass for the wrong reason.
        const realAllowedPath = realpathSync(symlinkedAllowed);
        expect(realAllowedPath).not.toBe(symlinkedAllowed);

        const wrapped = executor.wrapCommand(
          'echo ok',
          {
            workDir,
            allowedReadPaths: [symlinkedAllowed],
            allowedWritePaths: [symlinkedAllowed],
          },
          { enabled: true },
        );
        const profilePath = /-f '([^']+)'/.exec(wrapped)?.[1];
        expect(profilePath).toBeDefined();
        const profile = readFileSync(profilePath as string, 'utf8');
        rmSync(dirname(profilePath as string), { recursive: true, force: true });

        expect(profile).toContain(`(allow file-read* (subpath "${symlinkedAllowed}"))`);
        expect(profile).toContain(`(allow file-write* (subpath "${symlinkedAllowed}"))`);
        expect(profile).not.toContain(`(subpath "${realAllowedPath}")`);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });

    it('refuses the additive workDir rule when it resolves to the filesystem root, and warns', () => {
      const warn = vi.fn();
      const logger: InternalLogger = {
        child: () => logger,
        debug: () => {},
        info: () => {},
        warn,
        error: () => {},
      };
      const executor = getSandboxExecutor(logger);
      vi.spyOn(executor, 'getCapabilities').mockReturnValue({
        available: true,
        type: 'seatbelt',
        version: 'macOS built-in',
        features: {
          fileSystemIsolation: true,
          networkIsolation: true,
          processIsolation: true,
        },
      });

      const base = mkdtempSync(join(tmpdir(), 'sandbox-root-symlink-'));
      // A symlink whose target is "/" itself: realpathSync resolves it to "/"
      // without ever creating or touching anything under the real root.
      const rootWorkDir = join(base, 'points-at-root');
      symlinkSync('/', rootWorkDir);

      try {
        const wrapped = executor.wrapCommand(
          'echo ok',
          { workDir: rootWorkDir },
          { enabled: true },
        );
        const profilePath = /-f '([^']+)'/.exec(wrapped)?.[1];
        expect(profilePath).toBeDefined();
        const profile = readFileSync(profilePath as string, 'utf8');
        rmSync(dirname(profilePath as string), { recursive: true, force: true });

        // The literal given path is still covered...
        expect(profile).toContain(`(allow file-read* (subpath "${rootWorkDir}"))`);
        expect(profile).toContain(`(allow file-write* (subpath "${rootWorkDir}"))`);
        // ...but the additive rule for its resolved real path ("/") is refused.
        expect(profile).not.toContain('(allow file-read* (subpath "/"))');
        expect(profile).not.toContain('(allow file-write* (subpath "/"))');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain(rootWorkDir);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  });

  describe('buildExecutionOptions', () => {
    it('should create options with workDir', () => {
      const executor = getSandboxExecutor();
      const options = executor.buildExecutionOptions('/home/test/project');
      expect(options.workDir).toBe('/home/test/project');
    });

    it('should set allowNetwork to true by default', () => {
      const executor = getSandboxExecutor();
      const options = executor.buildExecutionOptions('/home/test');
      expect(options.allowNetwork).toBe(true);
    });

    it('should set allowNetwork to false when allowLocalBinding is false', () => {
      const executor = getSandboxExecutor();
      const options = executor.buildExecutionOptions('/home/test', {
        allowLocalBinding: false,
      });
      expect(options.allowNetwork).toBe(false);
    });

    it('should include home directory in allowedReadPaths', () => {
      const originalHome = process.env.HOME;
      process.env.HOME = '/home/testuser';

      const executor = getSandboxExecutor();
      const options = executor.buildExecutionOptions('/home/test');

      expect(options.allowedReadPaths).toContain('/home/testuser');

      process.env.HOME = originalHome;
    });
  });
});
