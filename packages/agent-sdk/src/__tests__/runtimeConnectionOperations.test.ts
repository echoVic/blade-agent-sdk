import { existsSync } from 'node:fs';
import { SessionId } from '../local/branded.js';
import { describe, expect, it } from 'vitest';

const connectionModulePath =
  '../session/runtimeConnectionOperations.js';
const connectionSourcePath =
  'src/session/runtimeConnectionOperations.ts';

describe('agent-sdk package-local runtime connection operations', () => {
  it('bundles session lifecycle with MCP operations without session runtime state', async () => {
    expect(existsSync(connectionSourcePath)).toBe(true);

    const { createPackageLocalRuntimeConnectionOperations } = await import(
      connectionModulePath
    );
    const calls: unknown[] = [];
    const configuredServers = {
      docs: {
        command: 'node',
        args: ['docs-server.js'],
      },
    };
    const operations = createPackageLocalRuntimeConnectionOperations({
      sessionId: SessionId('session-1'),
      sessionStore: {
        createSession(sessionId: string) {
          calls.push(['create', sessionId]);
        },
        loadSession(sessionId: string) {
          calls.push(['load', sessionId]);
          return true;
        },
        loadMessages(sessionId: string) {
          calls.push(['messages', sessionId]);
          return [{ role: 'user', content: 'hello' }];
        },
      },
      workspace: {
        updateWorkspace(update: unknown) {
          calls.push(['workspace', update]);
        },
      },
      hookRuntime: {
        runSessionEnd(event: unknown) {
          calls.push(['session-end', event]);
        },
      },
      model: 'glm-5.2',
      provider: 'openai-compatible',
      configuredServers,
      mcpRegistry: {
        disconnectAll() {
          calls.push(['disconnect-all']);
        },
        getCapabilities() {
          calls.push(['capabilities']);
          return [];
        },
        getAvailableToolsByServerNames(serverNames: string[]) {
          calls.push(['available-tools', serverNames]);
          return [];
        },
      },
      toolCatalog: {
        removeMcpTools(serverName: string) {
          calls.push(['remove-tools', serverName]);
          return 0;
        },
        registerMcpTool(tool: unknown, source: unknown) {
          calls.push(['register-mcp-tool', tool, source]);
        },
      },
      logger: {
        warn(...args: unknown[]) {
          calls.push(['warn', args]);
        },
      },
      filterTools(tools: unknown[]) {
        calls.push(['filter', tools]);
        return tools;
      },
      refreshMcpTools(serverNames: string[]) {
        calls.push(['refresh', serverNames]);
      },
    });

    expect(operations.mcp.servers.config.getConfigured()).toBe(configuredServers);
    await operations.session.lifecycle.ensureSessionCreated();
    await operations.session.lifecycle.close();
    await operations.mcp.tools.refresh(['docs']);

    expect(calls).toEqual([
      ['create', 'session-1'],
      ['session-end', { reason: 'other' }],
      ['disconnect-all'],
      ['remove-tools', 'docs'],
      ['available-tools', ['docs']],
      ['filter', []],
    ]);
  });
});
