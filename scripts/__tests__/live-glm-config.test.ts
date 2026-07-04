import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('live GLM config loader', () => {
  it('loads JSON .env files with key/url fields', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'blade-glm-json-env-'));
    writeFileSync(join(cwd, '.env'), JSON.stringify({
      _type: 'glm',
      key: 'json-key',
      url: 'https://glm.example.test/v1',
    }));

    // @ts-expect-error dynamic mjs helper is loaded at runtime by the live script.
    const { loadLiveGlmConfig } = await import('../live-glm-config.mjs');

    expect(loadLiveGlmConfig({ cwd, env: {} })).toEqual({
      apiKey: 'json-key',
      baseUrl: 'https://glm.example.test/v1',
      model: 'glm-5.2',
    });
  });

  it('lets process env aliases override .env defaults', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'blade-glm-kv-env-'));
    writeFileSync(join(cwd, '.env'), [
      'API_KEY=file-key',
      'BASE_URL=https://file.example.test/v1',
      'GLM_MODEL=glm-file',
    ].join('\n'));

    // @ts-expect-error dynamic mjs helper is loaded at runtime by the live script.
    const { loadLiveGlmConfig } = await import('../live-glm-config.mjs');

    expect(loadLiveGlmConfig({
      cwd,
      env: {
        GLM_API_KEY: 'env-key',
        GLM_BASE_URL: 'https://env.example.test/v1',
        GLM_MODEL: 'glm-env',
      },
    })).toEqual({
      apiKey: 'env-key',
      baseUrl: 'https://env.example.test/v1',
      model: 'glm-env',
    });
  });

  it('normalizes gateway root URLs to OpenAI-compatible /v1 base URLs', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'blade-glm-root-url-env-'));
    writeFileSync(join(cwd, '.env'), JSON.stringify({
      key: 'json-key',
      url: 'https://gateway.example.test/',
    }));

    // @ts-expect-error dynamic mjs helper is loaded at runtime by the live script.
    const { loadLiveGlmConfig } = await import('../live-glm-config.mjs');

    expect(loadLiveGlmConfig({ cwd, env: {} })).toMatchObject({
      baseUrl: 'https://gateway.example.test/v1',
    });
  });
});
