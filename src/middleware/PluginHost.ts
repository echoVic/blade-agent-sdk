import type { HookEvent } from '../types/constants.js';
import type {
  HookCallback,
  SessionHookEvent,
  SessionTool,
} from '../session/types.js';
import type {
  AgentMiddlewareConfig,
  AgentPlugin,
} from './AgentPlugin.js';
import type { ModelMiddleware } from './ModelMiddleware.js';
import type { ToolMiddleware } from './ToolMiddleware.js';

const PLUGIN_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export interface PluginToolRegistration {
  readonly pluginName: string;
  readonly tool: SessionTool;
}

interface PluginHostOptions {
  readonly middleware?: AgentMiddlewareConfig;
  readonly plugins?: readonly AgentPlugin[];
}

export class PluginHost {
  private readonly plugins: readonly AgentPlugin[];
  private readonly modelMiddleware: readonly ModelMiddleware[];
  private readonly toolMiddleware: readonly ToolMiddleware[];

  constructor(options: PluginHostOptions = {}) {
    this.plugins = [...(options.plugins ?? [])];
    this.assertPluginNames();
    this.modelMiddleware = [
      ...(options.middleware?.model ?? []),
      ...this.plugins.flatMap((plugin) => plugin.middleware?.model ?? []),
    ];
    this.toolMiddleware = [
      ...(options.middleware?.tool ?? []),
      ...this.plugins.flatMap((plugin) => plugin.middleware?.tool ?? []),
    ];
  }

  getModelMiddleware(): readonly ModelMiddleware[] {
    return this.modelMiddleware;
  }

  getToolMiddleware(): readonly ToolMiddleware[] {
    return this.toolMiddleware;
  }

  getTools(): readonly PluginToolRegistration[] {
    return this.plugins.flatMap((plugin) =>
      (plugin.tools ?? []).map((tool) => ({
        pluginName: plugin.name,
        tool,
      })),
    );
  }

  mergeHooks(
    sessionHooks: Partial<Record<SessionHookEvent, HookCallback[]>> = {},
  ): Partial<Record<HookEvent, HookCallback[]>> {
    const merged = Object.fromEntries(
      Object.entries(sessionHooks).map(([event, callbacks]) => [
        event,
        [...(callbacks ?? [])],
      ]),
    ) as Partial<Record<HookEvent, HookCallback[]>>;

    for (const plugin of this.plugins) {
      for (const [event, callbacks] of Object.entries(plugin.hooks ?? {})) {
        const hookEvent = event as SessionHookEvent;
        const bucket = merged[hookEvent] ?? [];
        bucket.push(...(callbacks ?? []));
        merged[hookEvent] = bucket;
      }
    }

    return merged;
  }

  private assertPluginNames(): void {
    const names = new Set<string>();
    for (const plugin of this.plugins) {
      if (
        typeof plugin.name !== 'string'
        || !PLUGIN_NAME_PATTERN.test(plugin.name)
      ) {
        throw new Error(
          `Agent plugin name "${plugin.name}" must be 1-64 lowercase letters, numbers, dots, underscores, or hyphens`,
        );
      }
      if (names.has(plugin.name)) {
        throw new Error(`Agent plugin "${plugin.name}" is registered more than once`);
      }
      names.add(plugin.name);
    }
  }
}
