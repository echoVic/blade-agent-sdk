import { describe, expect, it } from 'vitest';
import { createMcpServerTag, resolveMcpServerName } from '../toolSource.js';

describe('MCP tool source metadata', () => {
  it('uses an explicit server tag without treating generic lowercase tags as server names', () => {
    expect(
      resolveMcpServerName({
        name: 'search',
        tags: ['mcp', 'external', 'web', createMcpServerTag('docs')],
      }),
    ).toBe('docs');
  });

  it('falls back to the legacy MCP tool name and supports underscores in server names', () => {
    expect(
      resolveMcpServerName({
        name: 'mcp__docs_server__search',
        tags: ['mcp', 'external', 'web'],
      }),
    ).toBe('docs_server');
  });

  it('uses the generic MCP source when no server identity is encoded', () => {
    expect(
      resolveMcpServerName({
        name: 'search',
        tags: ['mcp', 'external', 'web'],
      }),
    ).toBe('mcp');
  });
});
