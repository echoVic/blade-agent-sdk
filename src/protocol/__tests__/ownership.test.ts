import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENT_PROTOCOL_VERSION,
  AgentCommandType,
  CommandId,
  parseAgentCommand,
} from '../../index.js';

function source(path: string): string {
  return readFileSync(resolve(path), 'utf8');
}

describe('protocol ownership', () => {
  it('keeps runtime configuration and credentials outside wire contracts', () => {
    const protocolTypes = source('src/protocol/types.ts');

    for (const forbidden of [
      'AgentOptions',
      'AgentRuntimeOptions',
      'ProviderConnectionConfig',
      'SessionOptions',
      'RuntimeStore',
      'apiKey',
    ]) {
      expect(protocolTypes).not.toContain(forbidden);
    }
  });

  it('rejects runtime configuration fields on session.create', () => {
    expect(() =>
      parseAgentCommand({
        protocolVersion: AGENT_PROTOCOL_VERSION,
        commandId: CommandId('command-create'),
        type: AgentCommandType.SESSION_CREATE,
        data: {
          metadata: { source: 'browser' },
          config: {
            model: 'deepseek-chat',
            apiKey: 'must-not-cross-wire',
          },
        },
      }),
    ).toThrow();
  });

  it('keeps internal execution types out of all package barrels', () => {
    for (const entrypoint of [
      'src/index.ts',
      'src/advanced/index.ts',
      'src/browser/index.ts',
      'src/core/index.ts',
      'src/node/index.ts',
      'src/protocol/index.ts',
      'src/server/infra.ts',
      'src/server/otel.ts',
      'src/server/postgres.ts',
      'src/server/testing/index.ts',
    ]) {
      const entry = source(entrypoint);
      for (const internalType of [
        'AgentRuntimeOptions',
        'AgentExecutionContext',
        'AgentConversationState',
        'AgentExecutionControl',
        'AgentExecutionServices',
        'ErasedToolDefinition',
        'SessionState',
      ]) {
        expect(entry, `${entrypoint} exports ${internalType}`).not.toMatch(
          new RegExp(`\\b${internalType}\\b`),
        );
      }
    }
  });

  it('keeps public event projection exhaustive instead of using a default cast', () => {
    const broadcaster = source('src/session/StreamBroadcaster.ts');

    expect(broadcaster).not.toContain('as SessionStreamEvent');
    expect(broadcaster).not.toMatch(/default\s*:/);
  });
});
