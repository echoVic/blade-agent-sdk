import { describe, expect, it } from 'vitest';
import { SessionId } from '../local/branded.js';
import {
  createSession,
  resetSessionRuntimeFactory,
  resumeSession,
} from '../session/index.js';
import { PackageLocalSession } from '../session/sessionInstance.js';
import type { SessionOptions } from '../session/types.js';

const options: SessionOptions = {
  provider: {
    type: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
  },
  model: 'test-model',
};

describe('agent-sdk default session factory', () => {
  it('returns package-local kernel sessions from public create and resume lifecycles', async () => {
    resetSessionRuntimeFactory();

    const created = await createSession(options);
    const resumed = await resumeSession({ ...options, sessionId: SessionId('existing-session') });

    expect(created).toBeInstanceOf(PackageLocalSession);
    expect(created.sessionId).not.toBe('created-legacy');
    expect(created.getDefaultContext()).toEqual({});
    expect(resumed).toBeInstanceOf(PackageLocalSession);
    expect(resumed.sessionId).toBe('existing-session');

    await created.close();
    await resumed.close();
  });
});
