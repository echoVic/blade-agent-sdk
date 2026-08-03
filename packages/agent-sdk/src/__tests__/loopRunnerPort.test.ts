import { describe, expect, it } from 'vitest';
import { LoopRunner } from '../session/loopRunner.js';
import { agentLoop } from '../session/agentLoopAdapter.js';
import { SessionId } from '../local/branded.js';

/**
 * Slice #346 — LoopRunner + the agent loop adapter ported into the package
 * session layer (session/loopRunner.ts, session/agentLoopAdapter.ts).
 *
 * The loop runner (config building via buildLoopConfig, agentLoop execution,
 * systemPrompt construction, runtime patch delegation) and the root adapter
 * glue (createPackageLocalAgentLoopPorts → handleAgentLoopWithEmissions) now
 * live in @blade-ai/agent-sdk/session/internal; the root LoopRunner.ts /
 * AgentLoop.ts / rootAgentLoopAdapter.ts are re-export shims.
 */

describe('LoopRunner (package session layer)', () => {
  it('exports the loop runner class', () => {
    expect(typeof LoopRunner).toBe('function');
  });

  it('exports the agent loop adapter generator factory', () => {
    expect(typeof agentLoop).toBe('function');
  });

  it('keeps the branded session id flow intact', () => {
    expect(SessionId('loop-session')).toBe('loop-session');
  });
});
