import { describe, expect, it } from 'vitest';
import type { SessionStreamEvent } from '../../session/types.js';
import { InputId, RequestId, SessionId } from '../../types/identifiers.js';
import { AgentResponse } from '../AgentResponse.js';

async function* events(values: readonly SessionStreamEvent[]): AsyncGenerator<SessionStreamEvent> {
  yield* values;
}

function response(values: readonly SessionStreamEvent[]): AgentResponse {
  return new AgentResponse(
    {
      status: 'started',
      inputId: InputId('input-1'),
      requestId: RequestId('request-1'),
    },
    events(values),
  );
}

describe('AgentResponse', () => {
  it('uses the successful result content when no content deltas were emitted', async () => {
    await expect(
      response([
        {
          type: 'result',
          subtype: 'success',
          content: 'final-only',
          sessionId: SessionId('session-1'),
        },
      ]).text(),
    ).resolves.toBe('final-only');
  });

  it('rejects text consumption when the response ends with an error event', async () => {
    await expect(
      response([
        {
          type: 'error',
          message: 'model failed',
          code: 'MODEL_FAILED',
          sessionId: SessionId('session-1'),
        },
      ]).text(),
    ).rejects.toThrow('model failed');
  });
});
