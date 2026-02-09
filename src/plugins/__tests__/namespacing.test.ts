import { describe, expect, it } from 'bun:test';
import { getNamespacedName, getMcpNamespacedName } from '../namespacing.js';

describe('namespacing', () => {
  describe('getNamespacedName', () => {
    it('should combine plugin name and resource name with colon', () => {
      expect(getNamespacedName('my-plugin', 'commit')).toBe('my-plugin:commit');
    });

    it('should handle empty plugin name', () => {
      expect(getNamespacedName('', 'commit')).toBe(':commit');
    });

    it('should handle empty resource name', () => {
      expect(getNamespacedName('my-plugin', '')).toBe('my-plugin:');
    });

    it('should handle names with special characters', () => {
      expect(getNamespacedName('my-plugin', 'run-tests')).toBe('my-plugin:run-tests');
    });

    it('should handle names with dots', () => {
      expect(getNamespacedName('org.plugin', 'task.run')).toBe('org.plugin:task.run');
    });
  });

  describe('getMcpNamespacedName', () => {
    it('should combine plugin name and server name with double underscore', () => {
      expect(getMcpNamespacedName('my-plugin', 'github')).toBe('my-plugin__github');
    });

    it('should handle empty plugin name', () => {
      expect(getMcpNamespacedName('', 'github')).toBe('__github');
    });

    it('should handle empty server name', () => {
      expect(getMcpNamespacedName('my-plugin', '')).toBe('my-plugin__');
    });

    it('should handle names with hyphens', () => {
      expect(getMcpNamespacedName('my-plugin', 'my-server')).toBe('my-plugin__my-server');
    });
  });
});
