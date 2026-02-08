/**
 * File Checkpointing Types
 *
 * Types for tracking file changes and enabling rewind functionality.
 */

export interface FileSnapshot {
  filePath: string;
  content: string | null;
  exists: boolean;
  timestamp: Date;
}

export interface FileChange {
  filePath: string;
  operation: 'create' | 'modify' | 'delete';
  beforeSnapshot: FileSnapshot | null;
  afterSnapshot: FileSnapshot;
  timestamp: Date;
}

export interface MessageCheckpoint {
  messageUuid: string;
  messageRole: 'user' | 'assistant';
  timestamp: Date;
  fileChanges: FileChange[];
  fileSnapshots: Map<string, FileSnapshot>;
}

export interface CheckpointConfig {
  enabled: boolean;
  maxCheckpoints?: number;
  excludePatterns?: string[];
}

export interface RewindResult {
  success: boolean;
  restoredFiles: string[];
  deletedFiles: string[];
  errors: RewindError[];
}

export interface RewindError {
  filePath: string;
  error: string;
}
