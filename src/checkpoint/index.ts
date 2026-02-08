/**
 * File Checkpointing Module
 *
 * Provides file change tracking and rewind functionality for sessions.
 */

export { CheckpointService, getCheckpointService } from './CheckpointService.js';
export type {
  CheckpointConfig,
  FileChange,
  FileSnapshot,
  MessageCheckpoint,
  RewindError,
  RewindResult,
} from './types.js';
