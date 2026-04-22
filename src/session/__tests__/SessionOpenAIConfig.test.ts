import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../Session.js';

describe('Session OpenAI config', () => {
  it('preserves native openai as the advertised provider type', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'session-openai-config-'));
    const session = await createSession({
      provider: {
        type: 'openai',
        apiKey: 'test-key',
        headers: {
          'X-Test': '1',
        },
        organization: 'org-test',
        projectId: 'proj-test',
      },
      model: 'gpt-5',
      defaultContext: {
        capabilities: {
          filesystem: {
            roots: [workspaceRoot],
            cwd: workspaceRoot,
          },
        },
      },
    });

    const supportedModels = await session.supportedModels();
    expect(supportedModels).toEqual([
      {
        id: 'default',
        name: 'gpt-5',
        provider: 'openai',
      },
    ]);

    await session.close();
  });
});
