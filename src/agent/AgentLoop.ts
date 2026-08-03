// Migration shim (slice #346): the agent loop adapter lives in
// @blade-ai/agent-sdk/session/internal (agentLoopAdapter.ts).
export { agentLoop } from '@blade-ai/agent-sdk/session/internal';
export type { AgentLoopConfig, AgentLoopHooks } from './loop/adapterContracts.js';
