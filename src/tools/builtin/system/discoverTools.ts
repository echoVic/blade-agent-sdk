import Type from 'typebox';
import { createTool } from '../../core/createTool.js';
import { ToolKind } from '../../behavior.js';
import { lazySchema } from '../../validation/lazySchema.js';

export const discoverToolsTool = createTool({
  name: 'DiscoverTools',
  displayName: 'Discover Tools',
  kind: ToolKind.ReadOnly,
  sideEffect: 'idempotent',
  services: ['discoverableCatalog'],
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
    const maxResults = params.max_results ?? 5;
    const matches = context.discoverableCatalog
      .listDiscoverable({
        query: params.query,
        permissionMode: context.permissionMode,
      })
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
    const summary = matches.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n');
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
