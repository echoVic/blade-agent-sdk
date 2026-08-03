// Migration shim (slice #338): the runtime patch lifecycle manager lives in
// @blade-ai/agent-sdk/local (RuntimePatchManager.ts). Root consumers
// (LoopRunner, LoopHookBuilder) keep the same import surface.
export { RuntimePatchManager } from '@blade-ai/agent-sdk/local';
