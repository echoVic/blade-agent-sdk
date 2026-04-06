/**
 * DenialTracker - Tracks denied tool operations within a session
 *
 * Prevents the agent from repeatedly requesting the same denied operation.
 * Keyed by permission signature (toolName:abstractedParams).
 */

export interface DenialRecord {
  signature: string;
  toolName: string;
  reason: string;
  count: number;
  firstDeniedAt: number;
  lastDeniedAt: number;
}

export class DenialTracker {
  private readonly denials = new Map<string, DenialRecord>();

  /** Record a denial for a given signature. */
  record(signature: string, toolName: string, reason: string): void {
    const existing = this.denials.get(signature);
    if (existing) {
      existing.count++;
      existing.lastDeniedAt = Date.now();
      existing.reason = reason;
    } else {
      this.denials.set(signature, {
        signature,
        toolName,
        reason,
        count: 1,
        firstDeniedAt: Date.now(),
        lastDeniedAt: Date.now(),
      });
    }
  }

  /** Check if a signature has been denied before. */
  isDenied(signature: string): boolean {
    return this.denials.has(signature);
  }

  /** Get the denial record for a signature, if any. */
  get(signature: string): DenialRecord | undefined {
    return this.denials.get(signature);
  }

  /** Get all denial records. */
  list(): DenialRecord[] {
    return Array.from(this.denials.values());
  }

  /** Clear all denials (e.g., on session reset). */
  clear(): void {
    this.denials.clear();
  }

  /** Remove a specific denial (e.g., user explicitly re-approves). */
  remove(signature: string): void {
    this.denials.delete(signature);
  }

  /** Summary for LLM context injection. */
  toSummary(): string {
    const records = this.list();
    if (records.length === 0) return '(no denied operations)';
    return records
      .map((r) => `- ${r.signature} (denied ${r.count}x: ${r.reason})`)
      .join('\n');
  }
}
