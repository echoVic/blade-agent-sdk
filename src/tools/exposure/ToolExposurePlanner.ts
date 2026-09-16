import { PermissionMode } from '../../types/constants.js';
import type { RegisteredTool, ToolRegistry, ToolSourcePolicy } from '../registry/ToolRegistry.js';
import { searchTools } from '../search/toolSearch.js';
import type { FunctionDeclaration, Tool, ToolExposureMode } from '../types/tool.js';

export interface RuntimeToolPolicySnapshot {
  allow?: string[];
  deny?: string[];
}

export interface DiscoverableToolInfo {
  name: string;
  title: string;
  description: string;
  exposureMode: Extract<ToolExposureMode, 'deferred' | 'discoverable-only'>;
  discoveryHint?: string;
}

export interface DiscoverableCatalogView {
  listDiscoverable(input: {
    query: string;
    permissionMode?: PermissionMode;
  }): readonly DiscoverableToolInfo[];
}

export interface ToolExposure {
  toolName: string;
  mode: ToolExposureMode | 'hidden';
  reason?: string;
}

export interface ToolExposurePlan {
  declarations: FunctionDeclaration[];
  exposures: ToolExposure[];
  discoverableTools: DiscoverableToolInfo[];
}

export interface ToolExposurePlannerOptions {
  permissionMode?: PermissionMode;
  runtimeToolPolicy?: RuntimeToolPolicySnapshot;
  discoveredTools?: Iterable<string>;
  sourcePolicy?: ToolSourcePolicy;
}

export class ToolExposurePlanner implements DiscoverableCatalogView {
  constructor(
    private readonly registry: Pick<ToolRegistry, 'entries'>,
    private readonly getDiscoveredTools: () => ReadonlySet<string> = () => new Set(),
  ) {}

  plan(options: ToolExposurePlannerOptions = {}): ToolExposurePlan {
    const declarations: FunctionDeclaration[] = [];
    const exposures: ToolExposure[] = [];
    const discoverableTools: DiscoverableToolInfo[] = [];
    const discovered = new Set(options.discoveredTools ?? []);
    const deniedTools = new Set(options.runtimeToolPolicy?.deny ?? []);
    const allowSelectors = options.runtimeToolPolicy?.allow;

    for (const entry of this.registry.entries()) {
      const { tool } = entry;
      const blockedReason = this.getBlockedReason(
        tool,
        entry,
        options.permissionMode,
        allowSelectors,
        deniedTools,
        options.sourcePolicy,
      );
      if (blockedReason) {
        exposures.push({
          toolName: tool.name,
          mode: 'hidden',
          reason: blockedReason,
        });
        continue;
      }

      const exposureMode = this.resolveExposureMode(tool, discovered);
      exposures.push({
        toolName: tool.name,
        mode: exposureMode,
      });

      if (exposureMode === 'eager') {
        declarations.push(tool.declaration);
        continue;
      }

      discoverableTools.push({
        name: tool.name,
        title: tool.title,
        description: tool.description.short,
        exposureMode,
        discoveryHint: tool.exposure.discoveryHint || undefined,
      });
    }

    return {
      declarations,
      exposures,
      discoverableTools,
    };
  }

  listDiscoverable(input: {
    query: string;
    permissionMode?: PermissionMode;
  }): readonly DiscoverableToolInfo[] {
    const eligible = new Map(
      this.plan({
        permissionMode: input.permissionMode,
        discoveredTools: this.getDiscoveredTools(),
      }).discoverableTools.map((tool) => [tool.name, tool]),
    );

    const tools = this.registry.entries().map((entry) => entry.tool);
    return searchTools(tools, input.query).flatMap((tool) => {
      const entry = eligible.get(tool.name);
      return entry ? [entry] : [];
    });
  }

  private getBlockedReason(
    tool: Tool,
    entry: RegisteredTool,
    permissionMode: PermissionMode | undefined,
    allowSelectors: string[] | undefined,
    deniedTools: Set<string>,
    sourcePolicy: ToolSourcePolicy | undefined,
  ): string | undefined {
    if (permissionMode === PermissionMode.PLAN && !tool.staticBehavior.isReadOnly) {
      return 'plan-mode-hidden';
    }

    if (sourcePolicy) {
      if (
        sourcePolicy.allowedSources &&
        sourcePolicy.allowedSources.length > 0 &&
        !sourcePolicy.allowedSources.includes(entry.source.kind)
      ) {
        return 'source-policy';
      }

      if (
        sourcePolicy.allowedTrustLevels &&
        sourcePolicy.allowedTrustLevels.length > 0 &&
        !sourcePolicy.allowedTrustLevels.includes(entry.source.trustLevel)
      ) {
        return 'source-policy';
      }
    }

    if (deniedTools.has(tool.name)) {
      return 'runtime-deny';
    }

    if (!allowSelectors || allowSelectors.length === 0) {
      return undefined;
    }

    if (allowSelectors.some((selector) => matchesToolSelector(selector, tool.name))) {
      return undefined;
    }

    return 'runtime-allow-list';
  }

  private resolveExposureMode(tool: Tool, discoveredTools: Set<string>): ToolExposureMode {
    if (discoveredTools.has(tool.name)) {
      return 'eager';
    }

    if (tool.exposure.alwaysLoad) {
      return 'eager';
    }

    if (tool.exposure.mode === 'deferred' && !discoveredTools.has(tool.name)) {
      return 'deferred';
    }

    if (tool.exposure.mode === 'discoverable-only') {
      return 'discoverable-only';
    }

    return 'eager';
  }
}

function matchesToolSelector(selector: string, toolName: string): boolean {
  if (selector === toolName) {
    return true;
  }

  const match = selector.match(/^(\w+)\(.*\)$/);
  return match?.[1] === toolName;
}
