export const VALID_SYSTEM_SOURCES = ['catalog', 'tool_injection', 'compaction_summary'] as const;

export type SystemSource = (typeof VALID_SYSTEM_SOURCES)[number];

export function isValidSystemSource(value: unknown): value is SystemSource {
  return typeof value === 'string' && VALID_SYSTEM_SOURCES.some((source) => source === value);
}
