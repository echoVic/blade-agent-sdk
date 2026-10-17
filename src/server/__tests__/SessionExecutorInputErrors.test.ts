import { describe, expect, it } from 'vitest';
import { SessionInputError } from '../../errors/SessionInputError.js';
import { AgentProtocolError } from '../../protocol/index.js';
import { toProtocolInputError } from '../SessionExecutor.js';

describe('toProtocolInputError', () => {
  it.each([
    ['SESSION_INPUT_IMAGE_REJECTED', 'INVALID_COMMAND', 400, false],
    ['SESSION_INPUT_OPTIONS_UNSUPPORTED', 'INVALID_COMMAND', 400, false],
    ['SESSION_REQUEST_MISMATCH', 'SESSION_CONFLICT', 409, false],
    ['SESSION_STEERING_UNAVAILABLE', 'SESSION_CONFLICT', 409, false],
    ['SESSION_INPUT_QUEUE_FULL', 'OVERLOADED', 503, true],
  ] as const)('maps %s', (code, protocolCode, status, retryable) => {
    const mapped = toProtocolInputError(new SessionInputError(code, 'refused'));
    expect(mapped).toBeInstanceOf(AgentProtocolError);
    expect(mapped).toMatchObject({ protocolCode, status, retryable, message: 'refused' });
  });

  it('keeps image rejection details and leaves other errors alone', () => {
    const rejected = new SessionInputError('SESSION_INPUT_IMAGE_REJECTED', 'bad image', {
      details: { index: 2, reason: 'media_type' },
    });
    expect(toProtocolInputError(rejected)).toMatchObject({
      details: { index: 2, reason: 'media_type' },
    });

    const other = new Error('boom');
    expect(toProtocolInputError(other)).toBe(other);
  });
});
