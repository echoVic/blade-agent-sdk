// Migration shim (slice #342): the tool execution pipeline lives in
// @blade-ai/agent-sdk/local (executionPipeline.ts). Root consumers
// (SessionRuntime, LoopHookBuilder, tests) keep the same import surface.
export { ExecutionPipeline } from '@blade-ai/agent-sdk/local';
export type { ExecutionPipelineConfig, ExecutionStats } from '@blade-ai/agent-sdk/local';
export type { ConfirmationReasonSource } from '@blade-ai/agent-sdk/local';
export type { ConfirmationReasonEntry } from '@blade-ai/agent-sdk/local';
