// Migration shim (slice #347): the session Agent + background agent manager
// live in @blade-ai/agent-sdk/session/internal (agent.ts,
// backgroundAgentManager.ts). Root consumers (Session.ts, SessionRuntime.ts)
// keep the same import surface.
export { Agent } from '@blade-ai/agent-sdk/session/internal';
export type { AgentRuntimeDeps } from '@blade-ai/agent-sdk/session/internal';
