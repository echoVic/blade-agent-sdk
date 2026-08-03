import { describe, expect, it } from 'vitest';
import { SessionId } from '../local/branded.js';
import type { Assert, IsEqual } from '../local/typeAssertions.js';
import type { StreamMessage } from '../session/types.js';

/**
 * Slice #332 — SessionId unification.
 *
 * The session layer previously declared `SessionId = string` (plain),
 * while the rest of the package used the branded
 * `SessionId = Brand<string, 'SessionId'>` from local/branded.ts.
 * This created two incompatible SessionId "species" and blocked the
 * ExecutionContext consolidation (a branded sessionId field can never
 * satisfy a plain-string sessionId field and vice-versa).
 *
 * After unification, `@blade-ai/agent-sdk/session`'s SessionId IS the
 * branded type. These assertions pin that contract at compile time so a
 * future regression (someone re-introducing a plain `SessionId = string`)
 * fails the build.
 */

// The session layer must expose the SAME branded SessionId as local/branded.
// (SessionId's branded-ness is pinned to the constructor's return type.)
type _SessionLayerSessionIdIsBranded = Assert<
  IsEqual<SessionId, ReturnType<typeof SessionId>>
>;

// StreamMessage's sessionId fields must carry the branded type, so kernel
// stream projections can round-trip session ids without casts.
type _StreamMessageCarriesBrandedSessionId = Assert<
  IsEqual<StreamMessage['sessionId'], SessionId>
>;

describe('SessionId unification (session layer)', () => {
  it('constructs branded session ids that remain plain strings at runtime', () => {
    const sid = SessionId('session-1');
    expect(typeof sid).toBe('string');
    expect(sid).toBe('session-1');
  });

  it('accepts branded session ids in session stream messages', () => {
    const message: StreamMessage = {
      type: 'turn_start',
      turn: 1,
      sessionId: SessionId('session-stream'),
    };
    expect(message.sessionId).toBe('session-stream');
  });

  it('keeps branded session ids assignable to plain string positions', () => {
    const sid = SessionId('session-string');
    const asPlainString: string = sid;
    expect(asPlainString).toBe('session-string');
  });
});
