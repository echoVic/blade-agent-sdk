/**
 * Context seed types for the @blade-ai/agent-sdk package.
 *
 * Provides canonical type definitions for context messages and related structures.
 * Root context/storage files (CacheStore, JSONLStore, MemoryStore, PersistentStore)
 * will eventually import these types from here.
 *
 * These are pure interface/type definitions — no runtime dependencies.
 */

import type { JsonObject } from '@blade-ai/ai';

/** Message role — valid sender identities in a conversation. */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/** A single message in the conversation context. */
export interface ContextMessage {
  /** Unique identifier for this message. */
  id: string;
  /** The role/sender of the message. */
  role: MessageRole;
  /** The textual content of the message. */
  content: string;
  /** Unix timestamp in milliseconds. */
  timestamp: number;
  /** Optional metadata attached to the message. */
  metadata?: JsonObject;
}

/** Context storage configuration options. */
export interface ContextStorageOptions {
  /** Maximum number of messages to keep in memory. */
  maxMemorySize: number;
  /** Optional filesystem path for persistent storage. */
  persistentPath?: string;
}

/** Context data after compaction — summary + key points + recent messages. */
export interface CompressedContext {
  /** Human-readable summary of the compacted context. */
  summary: string;
  /** Key points extracted from the compacted context. */
  keyPoints: string[];
  /** The most recent messages preserved after compaction. */
  recentMessages: ContextMessage[];
  /** Optional summary of tool usage during the compacted period. */
  toolSummary?: string;
  /** Token count after compaction. */
  tokenCount: number;
}
