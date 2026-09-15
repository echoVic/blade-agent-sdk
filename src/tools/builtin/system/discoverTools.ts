import Type from 'typebox';
import { createTool } from '../../core/createTool.js';
import { ToolKind } from '../../behavior.js';
import { ToolErrorType } from '../../types/result.js';
import { lazySchema } from '../../validation/lazySchema.js';

export const discoverToolsTool = createTool({
  name: 'DiscoverTools',
  displayName: 'Discover Tools',
  kind: ToolKind.ReadOnly,
  sideEffect: 'idempotent',
  description: {
    short: 'Search the hidden tool catalog and load matching tools into this conversation',
    long: `Use this when you suspect a specialized tool exists but it is not currently exposed in the active function list.

This tool searches deferred/discoverable tools, returns the best matches, and activates them for subsequent turns in the current session.`,
  },
  schema: lazySchema(() =>
    Type.Object({
      query: Type.String({
        minLength: 1,
        description: 'Search query for hidden tools',
      }),
      max_results: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 10,
          description: 'Maximum tools to activate',
        }),
      ),
    }),
  ),
  async *execute(params, context) {
    const searchCatalog = context.toolCatalog;
    const searchSource = searchCatalog ?? context.toolRegistry;
    if (!searchSource) {
      return {
        status: 'error',
        model: 'Tool discovery is unavailable because no tool registry was provided.',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: 'Tool registry is unavailable',
        },
        metadata: {
          summary: '工具发现不可用',
        },
      };
    }

    const maxResults = params.max_results ?? 5;
    const discovered = new Set(context.discoveredTools ?? []);
    const matches = searchSource
      .search(params.query)
      .filter((tool) => tool.exposure.mode !== 'eager' && !discovered.has(tool.name))
      .slice(0, maxResults);

    if (matches.length === 0) {
      return {
        status: 'success',
        model: `No hidden tools matched "${params.query}".`,
        metadata: {
          summary: '未找到匹配工具',
        },
      };
    }

    const activatedNames = matches.map((tool) => tool.name);
    const summary = matches.map((tool) => `- ${tool.name}: ${tool.description.short}`).join('\n');
    const runtimePatch = {
      scope: 'session' as const,
      source: 'tool' as const,
      toolDiscovery: {
        discover: activatedNames,
      },
    };

    yield {
      kind: 'effect',
      effect: {
        type: 'runtimePatch',
        patch: runtimePatch,
      },
    };

    return {
      status: 'success',
      model: `Activated deferred tools:\n${summary}`,
      metadata: {
        discoveredTools: activatedNames,
        summary: `发现 ${activatedNames.length} 个工具`,
      },
    };
  },
});
