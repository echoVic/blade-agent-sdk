// Migration shim (slice #337): the compaction orchestration service lives in
// @blade-ai/agent-sdk/local (compactionService.ts). Root consumers keep the
// same import surface.
export {
  compact,
  CompactionService,
  microcompactMessages,
} from '@blade-ai/agent-sdk/local';
export type {
  CompactionOptions,
  CompactionResult,
} from '@blade-ai/agent-sdk/local';
