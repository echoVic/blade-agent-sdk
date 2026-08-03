// Migration shim (slice #344): the compaction handler lives in
// @blade-ai/agent-sdk/local (compactionHandler.ts). Root consumers (Agent,
// LoopHookBuilder, LoopRunner) keep the same import surface.
export { CompactionHandler } from '@blade-ai/agent-sdk/local';
export type { CompactionRuntimeContext } from '@blade-ai/agent-sdk/local';
