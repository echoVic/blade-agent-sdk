import type { SessionId } from './branded.js';

/**
 * CompactionRuntimeContext — 压缩运行时上下文
 *
 * 传递当前 session 上下文给 compaction handler。
 */
export interface CompactionRuntimeContext {
  sessionId: SessionId;
  projectDir?: string;
}
