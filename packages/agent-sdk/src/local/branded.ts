/**
 * Branded types for the agent-sdk package.
 *
 * Uses string-based structural branding instead of `unique symbol`.
 * This ensures root and package branded types are structurally compatible,
 * enabling gradual migration of root files to the package.
 */

/** Structural brand — same string = same type. */
type Brand<T, B extends string> = T & { readonly _brand: B };

/** Session identifier. */
export type SessionId = Brand<string, 'SessionId'>;

/** Agent identifier. */
export type AgentId = Brand<string, 'AgentId'>;

/** Message identifier. */
export type MessageId = Brand<string, 'MessageId'>;

/** Tool use identifier. */
export type ToolUseId = Brand<string, 'ToolUseId'>;
