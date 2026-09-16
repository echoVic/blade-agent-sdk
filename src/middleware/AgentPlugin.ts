import type Type from 'typebox';
import type { HookCallback, SessionHookEvent } from '../session/types.js';
import type { ToolServiceName } from '../tools/services.js';
import type { ToolDefinition } from '../tools/types/tool.js';
import type { JsonValue } from '../types/json.js';
import type { ModelMiddleware } from './ModelMiddleware.js';
import type { ToolMiddleware } from './ToolMiddleware.js';

export interface AgentMiddlewareConfig {
  /**
   * The first middleware is the outermost onion layer.
   */
  readonly model?: readonly ModelMiddleware[];
  /**
   * The first middleware is the outermost onion layer.
   */
  readonly tool?: readonly ToolMiddleware[];
}

/**
 * Declarative extension bundle for one Session runtime.
 *
 * Plugins are resolved once during Session initialization. Middleware may
 * observe or transform live execution. Committed external effects must remain
 * declared tools so durable lifecycle and recovery rules still apply.
 */
export interface AgentPlugin {
  readonly name: string;
  readonly middleware?: AgentMiddlewareConfig;
  readonly hooks?: Partial<Record<SessionHookEvent, readonly HookCallback[]>>;
  readonly tools?: readonly ToolDefinition<Type.TSchema, JsonValue, ToolServiceName, boolean>[];
}

export function definePlugin<const TPlugin extends AgentPlugin>(plugin: TPlugin): TPlugin {
  return plugin;
}
