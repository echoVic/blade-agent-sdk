// Migration shim (slice #343): the model lifecycle manager lives in
// @blade-ai/agent-sdk/local (modelManager.ts). Root consumers (Agent,
// LoopHookBuilder, LoopRunner) keep the same import surface.
export { ModelManager } from '@blade-ai/agent-sdk/local';
