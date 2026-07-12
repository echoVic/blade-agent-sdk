export type { FileAccessLogger, FileAccessRecord } from './fileAccessTracker.js';
export { FileAccessTracker } from './fileAccessTracker.js';
export type { LocalFileStat, LocalFileSystemPort } from './filesystem.js';
export { createNodeLocalFileSystem } from './filesystem.js';
export type { ReadToolOptions } from './read.js';
export { createReadTool, readTool } from './read.js';
export type { WriteToolOptions } from './write.js';
export { createWriteTool, writeTool } from './write.js';
export type {
  Snapshot,
  SnapshotManagerOptions,
  SnapshotMetadata,
} from './snapshotManager.js';
export { SnapshotManager } from './snapshotManager.js';
export { isSensitivePath } from './sensitivePathCheck.js';
export {
  generateDiffSnippet,
  generateDiffSnippetWithMatch,
} from './diffUtils.js';
export {
  MatchStrategy,
  flexibleMatch,
  unescapeString,
  type MatchResult,
} from './editCorrector.js';
