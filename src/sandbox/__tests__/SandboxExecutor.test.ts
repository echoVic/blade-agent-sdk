import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { SandboxExecutor, getSandboxExecutor } from '../SandboxExecutor.js';

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

  describe('configure', () => {
    it('should store settings', () => {
      const executor = getSandboxExecutor();
      executor.configure({ enabled: true });
      expect(executor.isEnabled()).toBe(true);
    });
  });

  describe('isEnabled', () => {
    it('should return false by default', () => {
      const executor = getSandboxExecutor();
      expect(executor.isEnabled()).toBe(false);
    });

    it('should return true when enabled', () => {
      const executor = getSandboxExecutor();
      executor.configure({ enabled: true });
      expect(executor.isEnabled()).toBe(true);
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
    it('should return false when not enabled', () => {
      const executor = getSandboxExecutor();
      expect(executor.canUseSandbox()).toBe(false);
    });
  });

  describe('wrapCommand', () => {
    it('should return original command when sandbox cannot be used', () => {
      const executor = getSandboxExecutor();
      executor.configure({ enabled: false });
      const result = executor.wrapCommand('ls -la', { workDir: '/home/test' });
      expect(result).toBe('ls -la');
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
