import {
  CONVERSATION_MESSAGE_SOURCES,
  type ConversationMessageSource,
  isConversationMessageSource,
} from '../../model/conversation.js';

/**
 * 受控的非根 system 消息来源标识。
 *
 * provenance.source 是内部保留字段（语义标记），不是不可伪造的安全边界。
 * 入口归一化只接受这些枚举值，其余一律删除。
 */
export const VALID_SYSTEM_SOURCES = CONVERSATION_MESSAGE_SOURCES;

export type SystemSource = ConversationMessageSource;

/**
 * 检查给定值是否为合法的 SystemSource 枚举值。
 */
export function isValidSystemSource(value: unknown): value is SystemSource {
  return isConversationMessageSource(value);
}
