import { describe, expect, it } from 'vitest';
import { OAuthProvider, resolveOAuthRedirectUri } from '../OAuthProvider.js';

describe('OAuthProvider redirect and state validation', () => {
  it('accepts only the fixed loopback callback surface', () => {
    expect(resolveOAuthRedirectUri()).toBe('http://127.0.0.1:7777/oauth/callback');
    expect(resolveOAuthRedirectUri('http://localhost:7777/oauth/callback')).toBe(
      'http://localhost:7777/oauth/callback',
    );
    expect(resolveOAuthRedirectUri('http://[::1]:7777/oauth/callback')).toBe(
      'http://[::1]:7777/oauth/callback',
    );
  });

  it.each([
    'https://attacker.example/oauth/callback',
    'http://127.0.0.1:8888/oauth/callback',
    'http://127.0.0.1:7777/other',
    'http://user:password@127.0.0.1:7777/oauth/callback',
  ])('rejects an unsafe redirect URI: %s', (redirectUri) => {
    expect(() => resolveOAuthRedirectUri(redirectUri)).toThrow(/loopback URL/);
  });

  it('consumes a valid state exactly once and rejects expired state', () => {
    const provider = new OAuthProvider({} as never);
    const internals = provider as unknown as {
      pendingStates: Map<string, number>;
      consumeState(receivedState: string, expectedState: string): boolean;
    };
    internals.pendingStates.set('valid', Date.now() + 1000);
    internals.pendingStates.set('expired', Date.now() - 1);

    expect(internals.consumeState('valid', 'valid')).toBe(true);
    expect(internals.consumeState('valid', 'valid')).toBe(false);
    expect(internals.consumeState('expired', 'expired')).toBe(false);
  });
});
