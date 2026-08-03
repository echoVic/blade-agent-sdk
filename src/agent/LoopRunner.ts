// Migration shim (slice #346): the loop runner + agent loop adapter live in
// @blade-ai/agent-sdk/session/internal (loopRunner.ts, agentLoopAdapter.ts).
// Root consumers (Agent) keep the same import surface.
export { LoopRunner } from '@blade-ai/agent-sdk/session/internal';
