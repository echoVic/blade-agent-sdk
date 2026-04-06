import {
  resolveToolBehaviorSafely,
  type ToolBehavior,
  type ToolKind,
} from '../../tools/types/ToolTypes.js';

type InterruptBehavior = ToolBehavior['interruptBehavior'];

type ToolRegistryLike = {
  get(
    name: string,
  ):
    | {
        kind?: ToolKind;
        isReadOnly?: boolean;
        isConcurrencySafe?: boolean;
        isDestructive?: boolean;
        interruptBehavior?: InterruptBehavior;
        resolveBehavior?: (
          params: Record<string, unknown>,
        ) => Partial<ToolBehavior> | ToolBehavior;
      }
    | undefined;
};

export function resolveToolInterruptBehavior(
  registry: ToolRegistryLike,
  toolName: string,
  params: Record<string, unknown>,
): InterruptBehavior {
  const tool = registry.get(toolName);
  const behavior = resolveToolBehaviorSafely(tool, params);
  return behavior?.interruptBehavior ?? 'cancel';
}

export function createInterruptAwareAbortSignal(options: {
  outerSignal?: AbortSignal;
  batchSignal?: AbortSignal;
  interruptBehavior: InterruptBehavior;
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
