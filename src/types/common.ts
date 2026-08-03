/**
 * Common types
 *
 * ⚠️ MIGRATED: All common types now re-export from @blade-ai/agent-sdk.
 */

// Value + type re-exports (also available as runtime consts)
export { MessageRole, PermissionMode } from '@blade-ai/agent-sdk';

// Pure type re-exports
export type { JsonObject, JsonValue } from '@blade-ai/agent-sdk';
export type { TokenUsage } from '@blade-ai/agent-sdk';
export type { ProviderType } from '@blade-ai/agent-sdk';
export type { ModelConfig } from '@blade-ai/agent-sdk';
export type { McpServerConfig } from '@blade-ai/agent-sdk';
export type { PermissionsConfig } from '@blade-ai/agent-sdk';
export type { BladeConfig } from '@blade-ai/agent-sdk';
export type { OutputFormat } from '@blade-ai/agent-sdk';
export type { NetworkSandboxSettings } from '@blade-ai/agent-sdk';
export type { SandboxSettings } from '@blade-ai/agent-sdk';
