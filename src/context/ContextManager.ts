// Migration shim (slice #341): the context manager lives in
// @blade-ai/agent-sdk/local (contextManager.ts). Root consumers (Agent,
// SessionRuntime, ModelManager, LoopRunner, CompactionHandler) keep the same
// import surface.
export { ContextManager } from '@blade-ai/agent-sdk/local';
