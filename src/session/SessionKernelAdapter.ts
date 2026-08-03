// Migration shim (slice #336): the kernel tool port adapter lives in
// @blade-ai/agent-sdk/local (SessionKernelAdapter.ts), alongside the kernel
// hook/store/trace adapters. The phantom ExecutionPipelineLike/ToolRegistryLike
// interfaces were aligned to the real pipeline/registry APIs so the root
// ExecutionPipeline and package ToolRegistry satisfy them structurally.
export { createKernelToolPort } from '@blade-ai/agent-sdk/local';
export type { KernelToolPortOptions } from '@blade-ai/agent-sdk/local';
