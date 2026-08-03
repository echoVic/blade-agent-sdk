// Migration shim (slice #345): the agent loop config builder lives in
// @blade-ai/agent-sdk/local (loopHookBuilder.ts). Root consumers (Agent,
// LoopRunner) keep the same import surface.
export { buildLoopConfig } from '@blade-ai/agent-sdk/local';
export type { LoopHookBuilderDeps } from '@blade-ai/agent-sdk/local';
