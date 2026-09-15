import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import Type from 'typebox';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { createSdkMcpServer, tool, type SdkMcpServerHandle } from '../SdkMcpServer.js';

describe('SdkMcpServer', () => {
  let client: Client | undefined;
  let handle: SdkMcpServerHandle | undefined;

  afterEach(async () => {
    await client?.close();
    await handle?.server.close();
  });

  it('uses one TypeBox schema for inference, discovery, and runtime validation', async () => {
    const parameters = Type.Object(
      {
        name: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    );
    const greet = tool('greet', 'Greet a user', parameters, async ({ name }) => {
      expectTypeOf(name).toEqualTypeOf<string>();
      return {
        content: [{ type: 'text', text: `Hello, ${name}` }],
      };
    });
    handle = await createSdkMcpServer({
      name: 'typebox-server',
      version: '1.0.0',
      tools: [greet],
    });
    client = new Client({ name: 'typebox-client', version: '1.0.0' });
    await client.connect(await handle.createClientTransport());

    const listed = await client.listTools();
    expect(listed.tools[0]?.inputSchema).toEqual(parameters);

    const valid = await client.callTool({
      name: 'greet',
      arguments: { name: 'Blade' },
    });
    expect(valid).toMatchObject({
      content: [{ type: 'text', text: 'Hello, Blade' }],
    });

    const invalid = await client.callTool({
      name: 'greet',
      arguments: { name: '' },
    });
    expect(invalid.isError).toBe(true);
  });
});
