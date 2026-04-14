import type { Message } from '../../services/ChatServiceInterface.js';

/**
 * ConversationState — 消息单一事实源的封装边界。
 *
 * 核心不变量：
 * - slot [0] 为根 system prompt（如果存在），不可被外部操作修改或删除
 * - 不暴露可变 backing array，所有操作通过受控 API
 * - toArray() 返回浅拷贝（结构封装，不做对象级防变异）
 */
export class ConversationState {
  private readonly _messages: Message[];
  private readonly _hasRootSystemPrompt: boolean;

  constructor(
    rootSystemPrompt: Message | null,
    contextMessages: Message[],
    userMessage: Message,
  ) {
    this._messages = [];
    this._hasRootSystemPrompt = rootSystemPrompt !== null;
    if (rootSystemPrompt) {
      this._messages.push(rootSystemPrompt);
    }
    this._messages.push(...contextMessages, userMessage);
  }

  get hasRootSystemPrompt(): boolean {
    return this._hasRootSystemPrompt;
  }

  get length(): number {
    return this._messages.length;
  }

  // ===== 读取 =====

  /** 只读快照，供 LLM 调用和序列化（返回浅拷贝防止外部修改数组结构） */
  toArray(): readonly Message[] {
    return [...this._messages];
  }

  /** 剥离 root slot，保留所有其他消息（含非根 system）*/
  getContextMessages(): Message[] {
    if (!this._hasRootSystemPrompt) return [...this._messages];
    return this._messages.slice(1);
  }

  // ===== 尾部追加（AgentLoop 核心路径）=====

  /** 追加消息到尾部（助手响应、工具结果、注入消息等） */
  append(...messages: Message[]): void {
    this._messages.push(...messages);
  }

  // ===== System 块操作（RuntimePatchManager 用）=====

  /** 在 system 消息块末尾（第一个非 system 消息之前）插入 */
  insertAfterSystemBlock(message: Message): void {
    const insertIndex = this._messages.findIndex((m) => m.role !== 'system');
    if (insertIndex === -1) {
      this._messages.push(message);
    } else {
      this._messages.splice(insertIndex, 0, message);
    }
  }

  /** 替换指定索引的消息（仅限 root slot 之后） */
  replaceAt(index: number, message: Message): void {
    const minIndex = this._hasRootSystemPrompt ? 1 : 0;
    if (index < minIndex) throw new Error('Cannot replace root system prompt');
    this._messages[index] = message;
  }

  /** 删除指定索引的消息（仅限 root slot 之后） */
  removeAt(index: number): void {
    const minIndex = this._hasRootSystemPrompt ? 1 : 0;
    if (index < minIndex) throw new Error('Cannot remove root system prompt');
    this._messages.splice(index, 1);
  }

  /** 查找消息索引（供 RuntimePatchManager 定位 catalog） */
  findIndex(predicate: (msg: Message, index: number) => boolean): number {
    return this._messages.findIndex(predicate);
  }

  // ===== Compaction（替换非根内容）=====

  /**
   * 替换所有非根内容。root slot 保持不动。
   * 不变量：newMessages 禁止包含根 prompt（由调用方保证）。
   */
  replaceContent(newMessages: Message[]): void {
    const rootSlotCount = this._hasRootSystemPrompt ? 1 : 0;
    this._messages.splice(
      rootSlotCount,
      this._messages.length - rootSlotCount,
      ...newMessages,
    );
  }
}
