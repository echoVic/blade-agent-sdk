import type { RuntimeContext } from './RuntimeContext.js';
import type { RuntimePatchScope } from './RuntimePatch.js';

export interface RuntimeContextPatch {
  scope: RuntimePatchScope;
  context?: RuntimeContext;
  reset?: boolean;
}
