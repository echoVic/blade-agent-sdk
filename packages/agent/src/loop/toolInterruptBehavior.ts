import type { JsonObject } from '@blade-ai/ai';
import {
  resolveToolBehaviorSafely,
  type ToolExecutionRegistryLike,
  type ToolInterruptBehavior,
} from './toolBehavior.js';

export function resolveToolInterruptBehavior(
  registry: ToolExecutionRegistryLike,
  toolName: string,
  params: JsonObject,
): ToolInterruptBehavior {
  const tool = registry.get(toolName);
  const behavior = resolveToolBehaviorSafely(tool, params);
  return behavior?.interruptBehavior ?? 'cancel';
}

export function createInterruptAwareAbortSignal(options: {
  outerSignal?: AbortSignal;
  batchSignal?: AbortSignal;
  interruptBehavior: ToolInterruptBehavior;
}): { signal: AbortSignal; cleanup: () => void } {
  const trackedSignals: AbortSignal[] = [];

  if (options.batchSignal) {
    trackedSignals.push(options.batchSignal);
  }

  if (options.interruptBehavior === 'cancel' && options.outerSignal) {
    trackedSignals.push(options.outerSignal);
  }

  if (trackedSignals.length === 0) {
    const controller = new AbortController();
    return { signal: controller.signal, cleanup: () => {} };
  }

  if (trackedSignals.length === 1) {
    return { signal: trackedSignals[0], cleanup: () => {} };
  }

  if (trackedSignals.some((signal) => signal.aborted)) {
    const controller = new AbortController();
    controller.abort();
    return { signal: controller.signal, cleanup: () => {} };
  }

  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  for (const signal of trackedSignals) {
    signal.addEventListener('abort', abort);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const signal of trackedSignals) {
        signal.removeEventListener('abort', abort);
      }
    },
  };
}
