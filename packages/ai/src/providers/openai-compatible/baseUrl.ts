/**
 * Normalizes a user-supplied OpenAI-compatible base URL.
 *
 * Many self-hosted/aggregator gateways (e.g. New API / one-api style) are
 * documented with a root URL like `https://gateway.example.com` and serve the
 * OpenAI-compatible endpoints under `/v1`. The @ai-sdk/openai-compatible
 * provider appends `/chat/completions` directly to the baseURL, so a root
 * URL without `/v1` would hit `https://gateway.example.com/chat/completions`
 * (often an HTML page) instead of `/v1/chat/completions`.
 *
 * Rules:
 * - empty/blank input → undefined
 * - trailing slashes are trimmed
 * - a root path (`''` or `/`) gets `/v1` appended
 * - any explicit non-root path (e.g. `/v1`, `/custom/path`) is kept as-is
 */
export function normalizeOpenAICompatibleBaseUrl(baseUrl: string): string | undefined {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;

  try {
    const url = new URL(trimmed);
    if (url.pathname === '' || url.pathname === '/') {
      url.pathname = '/v1';
      return url.toString().replace(/\/$/, '');
    }
  } catch {
    return trimmed;
  }

  return trimmed;
}
