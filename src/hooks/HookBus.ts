import { HookEvent } from '../types/constants.js';
import type { HookCallback, HookInput, HookOutput } from '../session/types.js';

export class HookBus {
  constructor(
    private readonly callbacks: Partial<Record<HookEvent, HookCallback[]>> = {},
  ) {}

  has(event: HookEvent): boolean {
    return (this.callbacks[event]?.length ?? 0) > 0;
  }

  async dispatch(event: HookEvent, input: HookInput): Promise<HookOutput[]> {
    const hooks = this.callbacks[event];
    if (!hooks || hooks.length === 0) {
      return [];
    }

    const results: HookOutput[] = [];
    for (const hook of hooks) {
      results.push(await hook(input));
    }
    return results;
  }
}
