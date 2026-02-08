import { describe, expect, it } from 'bun:test';
import type { McpServerConfig } from '../../types/common.js';
import { ErrorType, McpClient } from '../McpClient.js';

describe('McpClient', () => {
  describe('constructor', () => {
    it('should create client with stdio config', () => {
      const config: McpServerConfig = {
        command: 'node',
        args: ['server.js'],
        type: 'stdio',
      };

      const client = new McpClient(config, 'test-server');
      expect(client).toBeDefined();
    });

    it('should create client with sse config', () => {
      const config: McpServerConfig = {
        command: '',
        type: 'sse',
        url: 'http://localhost:3000/sse',
      };

      const client = new McpClient(config, 'test-server');
      expect(client).toBeDefined();
    });

    it('should create client with http config', () => {
      const config: McpServerConfig = {
        command: '',
        type: 'http',
        url: 'http://localhost:3000/mcp',
      };

      const client = new McpClient(config, 'test-server');
      expect(client).toBeDefined();
    });

    it('should default to stdio type', () => {
      const config: McpServerConfig = {
        command: 'node',
        args: ['server.js'],
      };

      const client = new McpClient(config, 'test-server');
      expect(client).toBeDefined();
    });
  });

  describe('ErrorType', () => {
    it('should have NETWORK_TEMPORARY error type', () => {
      expect(ErrorType.NETWORK_TEMPORARY).toBe(ErrorType.NETWORK_TEMPORARY);
      expect(String(ErrorType.NETWORK_TEMPORARY)).toBe('network_temporary');
    });

    it('should have NETWORK_PERMANENT error type', () => {
      expect(ErrorType.NETWORK_PERMANENT).toBe(ErrorType.NETWORK_PERMANENT);
      expect(String(ErrorType.NETWORK_PERMANENT)).toBe('network_permanent');
    });

    it('should have CONFIG_ERROR error type', () => {
      expect(ErrorType.CONFIG_ERROR).toBe(ErrorType.CONFIG_ERROR);
      expect(String(ErrorType.CONFIG_ERROR)).toBe('config_error');
    });

    it('should have AUTH_ERROR error type', () => {
      expect(ErrorType.AUTH_ERROR).toBe(ErrorType.AUTH_ERROR);
      expect(String(ErrorType.AUTH_ERROR)).toBe('auth_error');
    });

    it('should have PROTOCOL_ERROR error type', () => {
      expect(ErrorType.PROTOCOL_ERROR).toBe(ErrorType.PROTOCOL_ERROR);
      expect(String(ErrorType.PROTOCOL_ERROR)).toBe('protocol_error');
    });

    it('should have UNKNOWN error type', () => {
      expect(ErrorType.UNKNOWN).toBe(ErrorType.UNKNOWN);
      expect(String(ErrorType.UNKNOWN)).toBe('unknown');
    });
  });

  describe('availableTools', () => {
    it('should return empty array before connection', () => {
      const config: McpServerConfig = {
        command: 'node',
        args: ['server.js'],
      };

      const client = new McpClient(config, 'test-server');
      expect(client.availableTools).toEqual([]);
    });
  });
});
