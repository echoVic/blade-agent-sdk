import type { ConversationMessage } from '../../model/conversation.js';

export class ConversationState {
  private readonly _messages: ConversationMessage[];
  private readonly _hasRootSystemPrompt: boolean;

  constructor(
    rootSystemPrompt: ConversationMessage | null,
    contextMessages: ConversationMessage[],
    userMessage: ConversationMessage,
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

  toArray(): readonly ConversationMessage[] {
    return [...this._messages];
  }

  getContextMessages(): ConversationMessage[] {
    if (!this._hasRootSystemPrompt) return [...this._messages];
    return this._messages.slice(1);
  }

  append(...messages: ConversationMessage[]): void {
    this._messages.push(...messages);
  }

  insertAfterSystemBlock(message: ConversationMessage): void {
    const insertIndex = this._messages.findIndex((m) => m.role !== 'system');
    if (insertIndex === -1) {
      this._messages.push(message);
    } else {
      this._messages.splice(insertIndex, 0, message);
    }
  }

  replaceAt(index: number, message: ConversationMessage): void {
    const minIndex = this._hasRootSystemPrompt ? 1 : 0;
    if (index < minIndex) throw new Error('Cannot replace root system prompt');
    this._messages[index] = message;
  }

  removeAt(index: number): void {
    const minIndex = this._hasRootSystemPrompt ? 1 : 0;
    if (index < minIndex) throw new Error('Cannot remove root system prompt');
    this._messages.splice(index, 1);
  }

  findIndex(predicate: (msg: ConversationMessage, index: number) => boolean): number {
    return this._messages.findIndex(predicate);
  }

  replaceContent(newMessages: ConversationMessage[]): void {
    const rootSlotCount = this._hasRootSystemPrompt ? 1 : 0;
    this._messages.splice(rootSlotCount, this._messages.length - rootSlotCount, ...newMessages);
  }
}
