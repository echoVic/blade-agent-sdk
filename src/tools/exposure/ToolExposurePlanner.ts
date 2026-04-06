import { PermissionMode } from '../../types/common.js';
import {
  resolveToolBehaviorHint,
  type FunctionDeclaration,
  type Tool,
  type ToolExposureMode,
} from '../types/index.js';
import type {
  ToolCatalogEntry,
  ToolCatalogReadView,
  ToolCatalogSourcePolicy,
} from '../catalog/ToolCatalog.js';

export interface RuntimeToolPolicySnapshot {
  allow?: string[];
  deny?: string[];
}

export interface ToolDiscoveryEntry {
  name: string;
  displayName: string;
  description: string;
  mode: Extract<ToolExposureMode, 'deferred' | 'discoverable-only'>;
  discoveryHint?: string;
}

export interface ToolExposure {
  toolName: string;
  mode: ToolExposureMode | 'hidden';
  reason?: string;
}

export interface ToolExposurePlan {
  declarations: FunctionDeclaration[];
  exposures: ToolExposure[];
  discoverableTools: ToolDiscoveryEntry[];
}

export interface ToolExposurePlannerOptions {
  permissionMode?: PermissionMode;
  runtimeToolPolicy?: RuntimeToolPolicySnapshot;
  discoveredTools?: Iterable<string>;
  sourcePolicy?: ToolCatalogSourcePolicy;
}

export class ToolExposurePlanner {
  constructor(private readonly catalog: ToolCatalogReadView) {}

  plan(options: ToolExposurePlannerOptions = {}): ToolExposurePlan {
    const catalogEntries = this.catalog.getEntries?.();
    const allTools = catalogEntries?.map((entry) => entry.tool) ?? this.catalog.getAll();
    const entryByName = new Map(catalogEntries?.map((entry) => [entry.tool.name, entry]) ?? []);

    if (allTools.length === 0 && this.catalog.getFunctionDeclarationsByMode) {
      return this.planFromDeclarations(options);
    }

    const declarations: FunctionDeclaration[] = [];
    const exposures: ToolExposure[] = [];
    const discoverableTools: ToolDiscoveryEntry[] = [];
    const discovered = new Set(options.discoveredTools ?? []);
    const deniedTools = new Set(options.runtimeToolPolicy?.deny ?? []);
    const allowSelectors = options.runtimeToolPolicy?.allow;

    for (const tool of allTools) {
      const blockedReason = this.getBlockedReason(
        tool,
        entryByName.get(tool.name),
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
        declarations.push(tool.getFunctionDeclaration());
        continue;
      }

      discoverableTools.push({
        name: tool.name,
        displayName: tool.displayName,
        description: tool.description.short,
        mode: exposureMode,
        discoveryHint: tool.exposure.discoveryHint || undefined,
      });
    }

    return {
      declarations,
      exposures,
      discoverableTools,
    };
  }

  private planFromDeclarations(options: ToolExposurePlannerOptions): ToolExposurePlan {
    const source = this.catalog.getFunctionDeclarationsByMode?.(options.permissionMode) ?? [];
    const deniedTools = new Set(options.runtimeToolPolicy?.deny ?? []);
    const allowSelectors = options.runtimeToolPolicy?.allow;
    const declarations = source.filter((tool) => {
      if (deniedTools.has(tool.name)) {
        return false;
      }
      if (!allowSelectors || allowSelectors.length === 0) {
        return true;
      }
      return allowSelectors.some((selector) => matchesToolSelector(selector, tool.name));
    });

    return {
      declarations,
      exposures: declarations.map((tool) => ({
        toolName: tool.name,
        mode: 'eager' as const,
      })),
      discoverableTools: [],
    };
  }

  private getBlockedReason(
    tool: Tool,
    entry: ToolCatalogEntry | undefined,
    permissionMode: PermissionMode | undefined,
    allowSelectors: string[] | undefined,
    deniedTools: Set<string>,
    sourcePolicy: ToolCatalogSourcePolicy | undefined,
  ): string | undefined {
    if (permissionMode === PermissionMode.PLAN && !resolveToolBehaviorHint(tool).isReadOnly) {
      return 'plan-mode-hidden';
    }

    if (entry && sourcePolicy) {
      if (
        sourcePolicy.allowedSources
        && sourcePolicy.allowedSources.length > 0
        && !sourcePolicy.allowedSources.includes(entry.source.kind)
      ) {
        return 'source-policy';
      }

      if (
        sourcePolicy.allowedTrustLevels
        && sourcePolicy.allowedTrustLevels.length > 0
        && !sourcePolicy.allowedTrustLevels.includes(entry.source.trustLevel)
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

  private resolveExposureMode(
    tool: Tool,
    discoveredTools: Set<string>,
  ): ToolExposureMode {
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
