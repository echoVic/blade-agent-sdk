import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectToolExecution } from '../../../types/result.js';
import { assertWebFetchUrl, webFetchTool } from '../webFetch.js';

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
      webFetchTool.execute(createParams(`http://127.0.0.1:${address.port}`), {
        bladeConfig: {
          models: [],
          webFetch: { allowPrivateNetwork: true },
        },
      }),
    );

    expect(result.status).toBe('error');
    expect(result.model).toBe('Request aborted');
    expect(result.error?.message).toBe('操作被中止');
    expect(result.metadata?.summary).toBe('GET 127.0.0.1 - aborted');
  });

  it.each([
    'file:///etc/passwd',
    'http://localhost/admin',
    'http://127.0.0.1:8080',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/admin',
    'http://[fc00::1]/admin',
  ])('blocks unsafe URL targets before issuing a request: %s', async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await collectToolExecution(webFetchTool.execute(createParams(url)));

    expect(result.status).toBe('error');
    expect(String(result.model)).toMatch(/WebFetch (only supports|blocked)/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enforces host allowlists and blocklists', () => {
    expect(() =>
      assertWebFetchUrl('https://api.example.com/resource', {
        allowedHosts: ['*.example.com'],
      }),
    ).not.toThrow();
    expect(() =>
      assertWebFetchUrl('https://example.net/resource', {
        allowedHosts: ['*.example.com'],
      }),
    ).toThrow(/allowlist/);
    expect(() =>
      assertWebFetchUrl('https://api.example.com/resource', {
        blockedHosts: ['*.example.com'],
      }),
    ).toThrow(/blocked host/);
  });

  it('revalidates redirects and blocks redirects to a private target', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/internal' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await collectToolExecution(
      webFetchTool.execute(createParams('https://example.com/start')),
    );

    expect(result.status).toBe('error');
    expect(String(result.model)).toContain('blocked non-public network address');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reports when a redirect changes POST to GET and drops the body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://example.com/final' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await collectToolExecution(
      webFetchTool.execute({
        ...createParams('https://example.com/start'),
        method: 'POST',
        body: '{"value":1}',
      }),
    );

    expect(result.status).toBe('success');
    expect(result.metadata?.body_dropped).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://example.com/final',
      expect.objectContaining({ method: 'GET', body: undefined }),
    );
  });

  it('does not forward credentials across redirect origins', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: 'https://other.example/final' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await collectToolExecution(
      webFetchTool.execute({
        ...createParams('https://example.com/start'),
        headers: {
          Authorization: 'Bearer secret',
          Cookie: 'session=secret',
          'X-Safe': 'kept',
        },
      }),
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://other.example/final',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Safe': 'kept' }),
      }),
    );
    const redirectedHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(redirectedHeaders.Authorization).toBeUndefined();
    expect(redirectedHeaders.Cookie).toBeUndefined();
  });
});
