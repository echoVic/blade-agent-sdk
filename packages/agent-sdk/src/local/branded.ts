/**
 * Branded types for the @blade-ai/agent-sdk package.
 *
 * Uses `unique symbol` branding (same mechanism as root branded types).
 * When the root branded.ts becomes a forwarder shim, both will share
 * the same __brand symbol via the package as the canonical source.
 *
 * NOTE: unique symbol is module-scoped. Root and package have separate
 * __brand instances until root is shimmed to re-export from the package.
 * This is by design — gradual migration toward the package as canonical.
 */

declare const __brand: unique symbol;

type Brand<T, B extends string> = T & { readonly [__brand]: B };

/** Session identifier (branded string). */
export type SessionId = Brand<string, 'SessionId'>;
/** Agent identifier (branded string). */
export type AgentId = Brand<string, 'AgentId'>;
/** Message identifier (branded string). */
export type MessageId = Brand<string, 'MessageId'>;
/** Tool use identifier (branded string). */
export type ToolUseId = Brand<string, 'ToolUseId'>;

/** Creates a SessionId from a string value. */
export const SessionId = (value: string): SessionId => value as SessionId;
/** Creates an AgentId from a string value. */
export const AgentId = (value: string): AgentId => value as AgentId;
/** Creates a MessageId from a string value. */
export const MessageId = (value: string): MessageId => value as MessageId;
/** Creates a ToolUseId from a string value. */
export const ToolUseId = (value: string): ToolUseId => value as ToolUseId;
