import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CustomCommand, CustomCommandExecutionContext } from './types.js';

export class CommandExecutor {
  async execute(
    command: CustomCommand,
    context: CustomCommandExecutionContext
  ): Promise<string> {
    let content = command.content;

    if (context.signal?.aborted) {
      throw new Error('Command execution aborted');
    }

    content = this.interpolateArgs(content, context.args);
    content = await this.executeBashEmbeds(content, context);
    content = await this.resolveFileReferences(content, context.workspaceRoot);

    return content;
  }

  private interpolateArgs(content: string, args: string[]): string {
    content = content.replace(/\$ARGUMENTS/g, args.join(' '));

    for (let i = 9; i >= 1; i--) {
      const placeholder = `$${i}`;
      const value = args[i - 1] ?? '';
      content = content.split(placeholder).join(value);
    }

    return content;
  }

  private async executeBashEmbeds(
    content: string,
    context: CustomCommandExecutionContext
  ): Promise<string> {
    const regex = /!`([^`]+)`/g;
    const matches: Array<{ match: string; command: string }> = [];

    for (const match of content.matchAll(regex)) {
      matches.push({
        match: match[0],
        command: match[1],
      });
    }

    let result = content;
    for (const { match: matchStr, command } of matches) {
      if (context.signal?.aborted) {
        result = result.replace(matchStr, '[Execution aborted]');
        continue;
      }

      try {
        const output = execSync(command, {
          cwd: context.workspaceRoot,
          encoding: 'utf-8',
          timeout: 30000,
          maxBuffer: 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();

        result = result.replace(matchStr, output);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        result = result.replace(
          matchStr,
          `[Error executing '${command}': ${errorMessage}]`
        );
      }
    }

    return result;
  }

  private async resolveFileReferences(
    content: string,
    workspaceRoot: string
  ): Promise<string> {
    const regex = /@([\w./-]+(?:\/[\w./-]+|\.[\w]+))/g;
    const matches: Array<{ match: string; relativePath: string }> = [];

    for (const match of content.matchAll(regex)) {
      matches.push({
        match: match[0],
        relativePath: match[1],
      });
    }

    let result = content;
    for (const { match: matchStr, relativePath } of matches) {
      const absolutePath = path.resolve(workspaceRoot, relativePath);

      try {
        const stat = fs.statSync(absolutePath);
        if (stat.isFile()) {
          const fileContent = fs.readFileSync(absolutePath, 'utf-8');
          const extension = path.extname(relativePath).slice(1) || 'text';
          const formattedContent = `\`\`\`${extension}\n${fileContent}\n\`\`\``;
          result = result.replace(matchStr, formattedContent);
        }
      } catch {
        // File not found, keep original text
      }
    }

    return result;
  }

  hasDynamicContent(content: string): {
    hasArgs: boolean;
    hasBashEmbeds: boolean;
    hasFileRefs: boolean;
  } {
    return {
      hasArgs: /\$ARGUMENTS|\$\d/.test(content),
      hasBashEmbeds: /!`[^`]+`/.test(content),
      hasFileRefs: /@[\w./-]+(?:\/[\w./-]+|\.[\w]+)/.test(content),
    };
  }
}
