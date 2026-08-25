import {
  resolveToolBehaviorSafely,
  type ToolBehavior,
  type ToolKind,
} from '../../tools/types/kind.js';
import type { JsonObject } from '../../types/json.js';

type InterruptBehavior = ToolBehavior['interruptBehavior'];

type ToolRegistryLike = {
  get(name: string):
    | {
        kind?: ToolKind;
        isReadOnly?: boolean;
        isConcurrencySafe?: boolean;
        isDestructive?: boolean;
        interruptBehavior?: InterruptBehavior;
        resolveBehavior?: (params: JsonObject) => Partial<ToolBehavior> | ToolBehavior;
      }
    | undefined;
};

export function resolveToolInterruptBehavior(
  registry: ToolRegistryLike,
  toolName: string,
  params: JsonObject,
): InterruptBehavior {
  const tool = registry.get(toolName);
  const behavior = resolveToolBehaviorSafely(tool, params);
  return behavior?.interruptBehavior ?? 'cancel';
}

export function createInterruptAwareAbortSignal(options: {
  requestSignal?: AbortSignal;
  steeringSignal?: AbortSignal;
  batchSignal?: AbortSignal;
  interruptBehavior: InterruptBehavior;
}): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];

  const linkSignal = (signal: AbortSignal | undefined, shouldPropagate: () => boolean) => {
    if (!signal) {
      return;
    }

    const propagate = () => {
      if (shouldPropagate() && !controller.signal.aborted) {
        controller.abort(signal.reason);
      }
    };
    if (signal.aborted) {
      propagate();
      return;
    }
    signal.addEventListener('abort', propagate, { once: true });
    cleanups.push(() => signal.removeEventListener('abort', propagate));
  };

  linkSignal(options.batchSignal, () => true);
  linkSignal(options.requestSignal, () => true);
  if (options.interruptBehavior === 'cancel') {
    linkSignal(options.steeringSignal, () => true);
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    },
  };
}
