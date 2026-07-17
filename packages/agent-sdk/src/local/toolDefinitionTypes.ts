/**
 * Tool definition types extracted from root tools/types/ToolDefinition.ts.
 * Zero root dependencies.
 */

export type ToolExposureMode = 'eager' | 'deferred' | 'discoverable-only';

export interface ToolExposureConfig {
  mode?: ToolExposureMode;
  alwaysLoad?: boolean;
  discoveryHint?: string;
}

export interface PreparedPermissionMatcher {
  signatureContent?: string;
  abstractRule?: string;
}
