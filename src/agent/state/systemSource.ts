/**
 * 受控的非根 system 消息来源标识。
 *
 * _systemSource 是内部保留字段（语义标记），不是不可伪造的安全边界。
 * 入口归一化只接受这些枚举值，其余一律删除。
 */
export const VALID_SYSTEM_SOURCES = ['catalog', 'tool_injection', 'compaction_summary'] as const;

export type SystemSource = (typeof VALID_SYSTEM_SOURCES)[number];

/**
 * 检查给定值是否为合法的 SystemSource 枚举值。
 */
export function isValidSystemSource(value: unknown): value is SystemSource {
  return typeof value === 'string' && VALID_SYSTEM_SOURCES.some((s) => s === value);
}
