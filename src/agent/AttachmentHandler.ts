import { type InternalLogger, LogCategory, NOOP_LOGGER } from '../logging/Logger.js';
import type { ModelContent } from '../model/message.js';
import { AttachmentCollector } from '../prompts/processors/AttachmentCollector.js';
import type { Attachment } from '../prompts/processors/types.js';
import type { UserMessageContent } from './types.js';

export class AttachmentHandler {
  private readonly collector: AttachmentCollector;
  private readonly logger: InternalLogger;

  constructor(cwd: string, logger: InternalLogger = NOOP_LOGGER) {
    this.logger = logger.child(LogCategory.AGENT);
    this.collector = new AttachmentCollector(
      { cwd, maxFileSize: 1024 * 1024, maxLines: 2000, maxTokens: 32000 },
      this.logger.child(LogCategory.PROMPTS),
    );
  }

  async processAtMentionsForContent(content: UserMessageContent): Promise<UserMessageContent> {
    const text =
      typeof content === 'string'
        ? content
        : content
            .filter((part): part is Extract<ModelContent, { type: 'text' }> => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
    if (!text) return content;
    try {
      const attachments = await this.collector.collect(text);
      if (attachments.length === 0) return content;
      const suffix = formatAttachments(attachments);
      this.logger.debug(`✅ Processed ${attachments.length} @ file mentions`);
      return typeof content === 'string'
        ? content + suffix
        : [...content, { type: 'text', text: suffix }];
    } catch (error) {
      this.logger.error('Failed to process @ mentions:', error);
      return content;
    }
  }
}

function formatAttachments(attachments: Attachment[]): string {
  const content: string[] = [];
  const errors: string[] = [];
  for (const attachment of attachments) {
    if (attachment.type === 'file') {
      const range = attachment.metadata.lineRange;
      const lines = range ? `${range.start}${range.end ? `-${range.end}` : ''}` : undefined;
      content.push(
        `<file path="${attachment.path}"${lines ? ` range="${lines}"` : ''}>`,
        attachment.content,
        '</file>',
      );
    } else if (attachment.type === 'directory') {
      content.push(`<directory path="${attachment.path}">`, attachment.content, '</directory>');
    } else {
      errors.push(`- @${attachment.path}: ${attachment.error}`);
    }
  }
  return [
    ...(content.length
      ? [
          '',
          '',
          '<system-reminder>',
          'The following files were mentioned with @ syntax:',
          '',
          ...content,
          '</system-reminder>',
        ]
      : []),
    ...(errors.length ? ['', '', '⚠️ Some files could not be loaded:', ...errors] : []),
  ].join('\n');
}
