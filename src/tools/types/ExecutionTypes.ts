// Migration shim (slice #335): the canonical ExecutionContext and its helpers
// live in @blade-ai/agent-sdk/tools (tools/types/ExecutionTypes.ts). The root
// duplicate (Omit-extension with root-branded overrides) is gone; the package
// SessionId/MessageId/ContextSnapshot/BladeConfig types are already canonical
// via root shims, so the package type is directly usable by root consumers.
export type {
  ConfirmationDetails,
  ConfirmationHandler,
  ConfirmationResponse,
  ExecutionContext,
  ExecutionHistoryEntry,
} from '@blade-ai/agent-sdk/tools';
export { getEffectiveProjectDir } from '@blade-ai/agent-sdk/tools';
