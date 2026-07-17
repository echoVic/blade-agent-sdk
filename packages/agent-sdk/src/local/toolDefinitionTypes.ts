/**
 * Tool definition types extracted from root tools/types/ToolDefinition.ts.
 * Zero root dependencies.
 */

import type { JSONSchema7 } from 'json-schema';

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

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: JSONSchema7;
}
