/**
 * Tool catalog types extracted from root ToolCatalog.ts.
 * Zero root dependencies.
 */

export type ToolSourceKind = 'builtin' | 'custom' | 'mcp' | 'session';

export type ToolTrustLevel = 'trusted' | 'workspace' | 'remote';

export interface ToolCatalogSourcePolicy {
  allowedSources?: ToolSourceKind[];
  allowedTrustLevels?: ToolTrustLevel[];
}
