import type { JsonObject, JsonValue } from '../../types/json.js';
import type { ToolBehavior } from '../behavior.js';

/** Internal, immutable snapshot of one schema-validated tool call. */
export interface ToolInvocation {
  readonly params: JsonObject;
  readonly behavior: ToolBehavior;
  readonly affectedPaths: readonly string[];
  readonly permissionSignature: string;
  readonly description: string;
}

export function createToolInvocation(input: ToolInvocation): ToolInvocation {
  deepFreezeJson(input.params);
  const behavior = Object.freeze({ ...input.behavior });
  const affectedPaths = Object.freeze([...input.affectedPaths]);
  return Object.freeze({
    params: input.params,
    behavior,
    affectedPaths,
    permissionSignature: input.permissionSignature,
    description: input.description,
  });
}

function deepFreezeJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreezeJson(item);
    }
    Object.freeze(value);
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) {
      deepFreezeJson(item);
    }
    Object.freeze(value);
  }
  return value;
}
