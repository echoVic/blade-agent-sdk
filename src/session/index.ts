export { createSession, forkSession, prompt, resumeSession } from './Session.js';
export type { ForkOptions, ResumeOptions } from './Session.js';
export * from './types.js';

// Kernel adapters — migrated to @blade-ai/agent-sdk/local (#112-#115)
export { createKernelTracePort } from '@blade-ai/agent-sdk/local';
export type { KernelTracePortOptions } from '@blade-ai/agent-sdk/local';
export { createKernelStorePort } from '@blade-ai/agent-sdk/local';
export type { KernelStorePortOptions, SessionMessageStore } from '@blade-ai/agent-sdk/local';
export { createSessionKernelModel, resolveSessionModelConfig } from '@blade-ai/agent-sdk/local';
export type { SessionKernelModel } from '@blade-ai/agent-sdk/local';
export { createKernelHookPort } from '@blade-ai/agent-sdk/local';
export type { HookRuntimeLike, KernelHookPortOptions } from '@blade-ai/agent-sdk/local';

