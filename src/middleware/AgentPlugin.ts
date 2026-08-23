import type {
  HookCallback,
  SessionHookEvent,
  SessionTool,
} from '../session/types.js';
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
 * Plugins are resolved once during Session initialization. Runtime side
 * effects belong in model/tool middleware, not in plugin construction.
 */
export interface AgentPlugin {
  readonly name: string;
  readonly middleware?: AgentMiddlewareConfig;
  readonly hooks?: Partial<
    Record<SessionHookEvent, readonly HookCallback[]>
  >;
  readonly tools?: readonly SessionTool[];
}

export function definePlugin<const TPlugin extends AgentPlugin>(
  plugin: TPlugin,
): TPlugin {
  return plugin;
}
