// Migration shim (slice #347): the background agent manager lives in
// @blade-ai/agent-sdk/session/internal (backgroundAgentManager.ts).
export { BackgroundAgentManager } from '@blade-ai/agent-sdk/session/internal';
export type { StartBackgroundAgentOptions } from '@blade-ai/agent-sdk/session/internal';
