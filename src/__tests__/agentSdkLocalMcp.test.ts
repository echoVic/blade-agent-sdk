import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  createSdkMcpServer,
  tool,
} from '../../packages/agent-sdk/src/local/mcp.js';

describe('agent-sdk local MCP facade', () => {
  it('creates in-process MCP handles from package-local tool definitions', async () => {
    const greet = tool(
      'greet',
      'Greet by name',
      { name: z.string() },
      async ({ name }) => ({
        content: [{ type: 'text', text: `hello ${name}` }],
      }),
    );

    expect(greet).toMatchObject({
      name: 'greet',
      description: 'Greet by name',
    });
    await expect(greet.handler({ name: 'blade' })).resolves.toEqual({
      content: [{ type: 'text', text: 'hello blade' }],
    });

    const handle = await createSdkMcpServer({
      name: 'local-tools',
      version: '1.0.0',
      tools: [greet],
    });

    expect(handle).toMatchObject({
      name: 'local-tools',
      version: '1.0.0',
    });
    await expect(handle.createClientTransport()).resolves.toBeTruthy();
    expect(handle.server).toBeTruthy();
  });
});
