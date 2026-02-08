import { createLogger, LogCategory } from '../logging/Logger.js';
import { AttachmentCollector } from '../prompts/processors/AttachmentCollector.js';
import type { Attachment } from '../prompts/processors/types.js';
import type { ContentPart } from '../services/ChatServiceInterface.js';
import type { UserMessageContent } from './types.js';

const logger = createLogger(LogCategory.AGENT);

export class AttachmentHandler {
  private attachmentCollector: AttachmentCollector;

  constructor(cwd: string) {
    this.attachmentCollector = new AttachmentCollector({
      cwd,
      maxFileSize: 1024 * 1024,
      maxLines: 2000,
      maxTokens: 32000,
    });
  }

  async processAtMentionsForContent(
    content: UserMessageContent
  ): Promise<UserMessageContent> {
    if (typeof content === 'string') {
      return this.processAtMentions(content);
    }

    const textParts: string[] = [];

    for (const part of content) {
      if (part.type === 'text') {
        textParts.push(part.text);
      }
    }

    if (textParts.length === 0) {
      return content;
    }

    const combinedText = textParts.join('\n');

    try {
      const attachments = await this.attachmentCollector.collect(combinedText);

      if (attachments.length === 0) {
        return content;
      }

      logger.debug(
        `✅ Processed ${attachments.length} @ file mentions in multimodal message`
      );

      const attachmentText = this.buildAttachmentText(attachments);

      if (!attachmentText) {
        return content;
      }

      const result: ContentPart[] = [
        ...content,
        { type: 'text', text: attachmentText },
      ];

      return result;
    } catch (error) {
      logger.error('Failed to process @ mentions in multimodal message:', error);
      return content;
    }
  }

  private buildAttachmentText(attachments: Attachment[]): string {
    const contextBlocks: string[] = [];
    const errors: string[] = [];

    for (const att of attachments) {
      if (att.type === 'file') {
        const lineInfo = att.metadata?.lineRange
          ? ` (lines ${att.metadata.lineRange.start}${att.metadata.lineRange.end ? `-${att.metadata.lineRange.end}` : ''})`
          : '';

        contextBlocks.push(
          `<file path="${att.path}"${lineInfo ? ` range="${lineInfo}"` : ''}>`,
          att.content,
          '</file>'
        );
      } else if (att.type === 'directory') {
        contextBlocks.push(
          `<directory path="${att.path}">`,
          att.content,
          '</directory>'
        );
      } else if (att.type === 'error') {
        errors.push(`- @${att.path}: ${att.error}`);
      }
    }

    let result = '';

    if (contextBlocks.length > 0) {
      result += '\n\n<system-reminder>\n';
      result += 'The following files were mentioned with @ syntax:\n\n';
      result += contextBlocks.join('\n');
      result += '\n</system-reminder>';
    }

    if (errors.length > 0) {
      result += '\n\n⚠️ Some files could not be loaded:\n';
      result += errors.join('\n');
    }

    return result;
  }

  private async processAtMentions(message: string): Promise<string> {
    try {
      const attachments = await this.attachmentCollector.collect(message);

      if (attachments.length === 0) {
        return message;
      }

      logger.debug(`✅ Processed ${attachments.length} @ file mentions`);

      return this.appendAttachments(message, attachments);
    } catch (error) {
      logger.error('Failed to process @ mentions:', error);
      return message;
    }
  }

  private appendAttachments(message: string, attachments: Attachment[]): string {
    const contextBlocks: string[] = [];
    const errors: string[] = [];

    for (const att of attachments) {
      if (att.type === 'file') {
        const lineInfo = att.metadata?.lineRange
          ? ` (lines ${att.metadata.lineRange.start}${att.metadata.lineRange.end ? `-${att.metadata.lineRange.end}` : ''})`
          : '';

        contextBlocks.push(
          `<file path="${att.path}"${lineInfo ? ` range="${lineInfo}"` : ''}>`,
          att.content,
          '</file>'
        );
      } else if (att.type === 'directory') {
        contextBlocks.push(
          `<directory path="${att.path}">`,
          att.content,
          '</directory>'
        );
      } else if (att.type === 'error') {
        errors.push(`- @${att.path}: ${att.error}`);
      }
    }

    let enhancedMessage = message;

    if (contextBlocks.length > 0) {
      enhancedMessage += '\n\n<system-reminder>\n';
      enhancedMessage += 'The following files were mentioned with @ syntax:\n\n';
      enhancedMessage += contextBlocks.join('\n');
      enhancedMessage += '\n</system-reminder>';
    }

    if (errors.length > 0) {
      enhancedMessage += '\n\n⚠️ Some files could not be loaded:\n';
      enhancedMessage += errors.join('\n');
    }

    return enhancedMessage;
  }
}
