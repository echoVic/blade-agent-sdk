/**
 * Runtime-independent transaction boundary for streaming tool execution.
 *
 * A new epoch identifies a fresh loop iteration. Invalidating an epoch lets
 * callers discard late events or side effects from older retries.
 */
export class ExecutionEpoch {
  private static counter = 0;
  private valid = true;
  private readonly epochId: number;

  constructor() {
    this.epochId = ++ExecutionEpoch.counter;
  }

  get id(): number {
    return this.epochId;
  }

  get isValid(): boolean {
    return this.valid;
  }

  invalidate(): void {
    this.valid = false;
  }
}
