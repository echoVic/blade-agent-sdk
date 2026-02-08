import { describe, expect, it } from 'bun:test';
import { McpConnectionStatus } from '../types.js';

describe('MCP Types', () => {
  describe('McpConnectionStatus', () => {
    it('should have DISCONNECTED status', () => {
      expect(McpConnectionStatus.DISCONNECTED).toBe(McpConnectionStatus.DISCONNECTED);
      expect(String(McpConnectionStatus.DISCONNECTED)).toBe('disconnected');
    });

    it('should have CONNECTING status', () => {
      expect(McpConnectionStatus.CONNECTING).toBe(McpConnectionStatus.CONNECTING);
      expect(String(McpConnectionStatus.CONNECTING)).toBe('connecting');
    });

    it('should have CONNECTED status', () => {
      expect(McpConnectionStatus.CONNECTED).toBe(McpConnectionStatus.CONNECTED);
      expect(String(McpConnectionStatus.CONNECTED)).toBe('connected');
    });

    it('should have ERROR status', () => {
      expect(McpConnectionStatus.ERROR).toBe(McpConnectionStatus.ERROR);
      expect(String(McpConnectionStatus.ERROR)).toBe('error');
    });

    it('should have exactly 4 status values', () => {
      const statusValues = Object.values(McpConnectionStatus);
      expect(statusValues).toHaveLength(4);
    });
  });
});
