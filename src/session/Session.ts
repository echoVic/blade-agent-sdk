// Migration shim (slice #348): the legacy session factory + class live in
// @blade-ai/agent-sdk/session/internal (legacySession.ts).
export { createSession, forkSession, prompt, resumeSession } from '@blade-ai/agent-sdk/session/internal';
export type { ForkOptions, ResumeOptions } from '@blade-ai/agent-sdk/session/internal';
