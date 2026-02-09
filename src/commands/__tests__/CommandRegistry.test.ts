import { describe, expect, it, beforeEach } from 'bun:test';
import { CommandRegistry } from '../CommandRegistry.js';

describe('CommandRegistry', () => {
  beforeEach(() => {
    CommandRegistry.resetInstance();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const a = CommandRegistry.getInstance();
      const b = CommandRegistry.getInstance();
      expect(a).toBe(b);
    });

    it('should return new instance after reset', () => {
      const a = CommandRegistry.getInstance();
      CommandRegistry.resetInstance();
      const b = CommandRegistry.getInstance();
      expect(a).not.toBe(b);
    });
  });

  describe('isInitialized', () => {
    it('should return false before initialization', () => {
      const registry = CommandRegistry.getInstance();
      expect(registry.isInitialized()).toBe(false);
    });
  });

  describe('getCommand', () => {
    it('should return undefined for non-existent command', () => {
      const registry = CommandRegistry.getInstance();
      expect(registry.getCommand('nonexistent')).toBeUndefined();
    });
  });

  describe('hasCommand', () => {
    it('should return false for non-existent command', () => {
      const registry = CommandRegistry.getInstance();
      expect(registry.hasCommand('nonexistent')).toBe(false);
    });
  });

  describe('getAllCommands', () => {
    it('should return empty array before initialization', () => {
      const registry = CommandRegistry.getInstance();
      expect(registry.getAllCommands()).toEqual([]);
    });
  });

  describe('getCommandCount', () => {
    it('should return 0 before initialization', () => {
      const registry = CommandRegistry.getInstance();
      expect(registry.getCommandCount()).toBe(0);
    });
  });

  describe('getCommandLabel', () => {
    it('should return project label for project commands', () => {
      const registry = CommandRegistry.getInstance();
      const cmd = {
        name: 'test',
        source: 'project' as const,
        sourceDir: 'blade' as const,
        config: {},
        content: '',
        path: '/test',
      };
      expect(registry.getCommandLabel(cmd)).toBe('(project)');
    });

    it('should return user label for user commands', () => {
      const registry = CommandRegistry.getInstance();
      const cmd = {
        name: 'test',
        source: 'user' as const,
        sourceDir: 'blade' as const,
        config: {},
        content: '',
        path: '/test',
      };
      expect(registry.getCommandLabel(cmd)).toBe('(user)');
    });

    it('should include namespace in label', () => {
      const registry = CommandRegistry.getInstance();
      const cmd = {
        name: 'test',
        namespace: 'utils',
        source: 'project' as const,
        sourceDir: 'blade' as const,
        config: {},
        content: '',
        path: '/test',
      };
      expect(registry.getCommandLabel(cmd)).toBe('(project:utils)');
    });
  });

  describe('getCommandDisplayName', () => {
    it('should format command display name', () => {
      const registry = CommandRegistry.getInstance();
      const cmd = {
        name: 'test',
        source: 'project' as const,
        sourceDir: 'blade' as const,
        config: { description: 'Run tests' },
        content: '',
        path: '/test',
      };
      const display = registry.getCommandDisplayName(cmd);
      expect(display).toContain('/test');
      expect(display).toContain('Run tests');
    });

    it('should include argument hint', () => {
      const registry = CommandRegistry.getInstance();
      const cmd = {
        name: 'test',
        source: 'project' as const,
        sourceDir: 'blade' as const,
        config: { argumentHint: '<file>' },
        content: '',
        path: '/test',
      };
      const display = registry.getCommandDisplayName(cmd);
      expect(display).toContain('<file>');
    });
  });

  describe('getCommandsBySource', () => {
    it('should return empty arrays before initialization', () => {
      const registry = CommandRegistry.getInstance();
      const result = registry.getCommandsBySource();
      expect(result.project).toEqual([]);
      expect(result.user).toEqual([]);
    });
  });

  describe('getLastDiscoveryResult', () => {
    it('should return null before initialization', () => {
      const registry = CommandRegistry.getInstance();
      expect(registry.getLastDiscoveryResult()).toBeNull();
    });
  });

  describe('getCommandDirs', () => {
    it('should return null before initialization', () => {
      const registry = CommandRegistry.getInstance();
      expect(registry.getCommandDirs()).toBeNull();
    });
  });

  describe('generateCommandListDescription', () => {
    it('should return no commands message when empty', () => {
      const registry = CommandRegistry.getInstance();
      const result = registry.generateCommandListDescription();
      expect(result.text).toContain('No custom commands');
      expect(result.includedCount).toBe(0);
      expect(result.totalCount).toBe(0);
    });
  });

  describe('refresh', () => {
    it('should throw when not initialized', async () => {
      const registry = CommandRegistry.getInstance();
      await expect(registry.refresh()).rejects.toThrow('not initialized');
    });
  });
});
