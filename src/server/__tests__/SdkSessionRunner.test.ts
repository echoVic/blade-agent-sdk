import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRunnerContext } from '../../advanced/SessionRunner.js';
import { resumeSession } from '../../session/Session.js';
import type { ISession, SessionStreamEvent } from '../../session/types.js';
import { RequestId, SessionId } from '../../types/identifiers.js';
import { SdkSessionRunner } from '../SdkSessionRunner.js';

vi.mock('../../session/Session.js', () => ({ resumeSession: vi.fn() }));

const sessionId = SessionId('runner-session');
const requestId = RequestId('accepted-request');

function setup(events: () => AsyncGenerator<SessionStreamEvent>, signal: AbortSignal) {
  const handoff = vi.fn(async () => ({
    headSequence: 12,
    recoveryPlan: { action: 'resume_request' },
  }));
  vi.mocked(resumeSession).mockResolvedValue({
    stream: events,
    getDurableProjection: () => ({ activeRequest: { requestId } }),
    suspendForHandoff: handoff,
  } as unknown as ISession);
  const tenantStore = {};
  const context = {
    claim: {
      route: { tenantId: 'tenant', sessionId, metadata: {} },
      lease: {
        ownerId: 'worker',
        leaseId: 'lease',
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      },
    },
    store: { forTenant: () => tenantStore },
    signal,
    transition: vi.fn(async () => undefined),
  } as unknown as SessionRunnerContext;
  const publish = vi.fn(
    async (
      _tenantId: string,
      _sessionId: unknown,
      _type: string,
      _data: unknown,
      _requestId?: unknown,
    ) => undefined,
  );
  const runner = new SdkSessionRunner({
    resolveSessionOptions: () => ({
      provider: { type: 'openai', apiKey: 'test' },
      model: 'test-model',
    }),
    publish,
  });
  return { runner, context, publish, handoff };
}

describe('SdkSessionRunner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('correlates content and terminal events with the durable accepted request', async () => {
    const { runner, context, publish } = setup(async function* () {
      yield { type: 'content', delta: 'Hello', sessionId };
      yield { type: 'result', subtype: 'success', content: 'Hello', sessionId };
    }, new AbortController().signal);

    const result = await runner.run(context);
    expect(result).toMatchObject({ status: 'idle' });
    // The terminal result is withheld until the Worker has settled the route, so a
    // client cannot see a finished request while the route still reads `running`.
    expect(publish.mock.calls).toHaveLength(1);
    expect(publish.mock.calls[0]?.[3]).toMatchObject({ type: 'content' });

    await result.finalize?.();

    expect(publish.mock.calls).toHaveLength(2);
    expect(publish.mock.calls[1]?.[3]).toMatchObject({ type: 'result', subtype: 'success' });
    for (const call of publish.mock.calls) {
      expect(call).toEqual(['tenant', sessionId, 'session.stream', expect.any(Object), requestId]);
    }
  });

  it('publishes the terminal result after a failure too, so the route and the client agree', async () => {
    const { runner, context, publish } = setup(async function* () {
      yield { type: 'result', subtype: 'error', error: 'model failed', sessionId };
    }, new AbortController().signal);

    const result = await runner.run(context);
    expect(result).toMatchObject({ status: 'failed' });
    expect(publish).not.toHaveBeenCalled();

    await result.finalize?.();
    expect(publish.mock.calls[0]?.[3]).toMatchObject({ type: 'result', subtype: 'error' });
  });

  it('returns suspended when handoff ends the stream without throwing', async () => {
    const controller = new AbortController();
    const { runner, context, handoff } = setup(async function* () {
      yield { type: 'content', delta: 'Partial', sessionId };
      controller.abort(new Error('Worker draining'));
    }, controller.signal);

    await expect(runner.run(context)).resolves.toMatchObject({
      status: 'suspended',
      metadata: { durableHandoff: { recoveryAction: 'resume_request' } },
    });
    expect(handoff).toHaveBeenCalledTimes(1);
  });
});
