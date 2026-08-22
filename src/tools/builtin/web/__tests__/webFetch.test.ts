import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectToolExecution } from '../../../types/index.js';
import { webFetchTool } from '../webFetch.js';

const servers: Server[] = [];

function createParams(url: string) {
  return {
    url,
    method: 'GET' as const,
    extract_content: false,
    follow_redirects: true,
    max_redirects: 5,
    return_headers: false,
    timeout: 1000,
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();

  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe('WebFetch Tool', () => {
  it('preserves abort semantics when fetch throws a DOMException', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new DOMException('This operation was aborted', 'AbortError')),
    );

    const result = await collectToolExecution(
      webFetchTool.execute(createParams('https://example.com')),
    );

    expect(result.status).toBe('error');
    expect(result.model).toBe('Request aborted');
    expect(result.error?.message).toBe('操作被中止');
    expect(result.metadata?.summary).toBe('GET example.com - aborted');
  });

  it('reports a timeout from Node fetch as an aborted request', async () => {
    const server = createServer(() => {
      // Keep the request pending until WebFetch aborts it.
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected the test server to listen on a TCP port');
    }

    const result = await collectToolExecution(
      webFetchTool.execute(createParams(`http://127.0.0.1:${address.port}`)),
    );

    expect(result.status).toBe('error');
    expect(result.model).toBe('Request aborted');
    expect(result.error?.message).toBe('操作被中止');
    expect(result.metadata?.summary).toBe('GET 127.0.0.1 - aborted');
  });
});
