import type { JsonObject } from '../../../types/json.js';

function getString(params: JsonObject, key: string, defaultValue = ''): string {
  const value = params[key];
  return typeof value === 'string' ? value : defaultValue;
}

/** Human-readable preview of the change a mutating tool is about to make. */
export function generatePreviewForTool(toolName: string, params: JsonObject): string | undefined {
  switch (toolName) {
    case 'Edit': {
      const oldString = getString(params, 'old_string');
      const newString = getString(params, 'new_string');
      if (!oldString && !newString) return undefined;

      const maxLines = 20;
      const truncate = (text: string): string => {
        const lines = text.split('\n');
        if (lines.length <= maxLines) return text;
        return `${lines.slice(0, maxLines).join('\n')}\n... (还有 ${lines.length - maxLines} 行)`;
      };

      return `**变更前:**\n\`\`\`\n${truncate(oldString || '(空)')}\n\`\`\`\n\n**变更后:**\n\`\`\`\n${truncate(newString || '(删除)')}\n\`\`\``;
    }
    case 'Write': {
      const content = getString(params, 'content');
      const encoding = getString(params, 'encoding', 'utf8');
      if (encoding !== 'utf8' || !content) {
        return `将写入 ${encoding === 'base64' ? 'Base64 编码' : encoding === 'binary' ? '二进制' : ''} 内容`;
      }

      const maxLines = 30;
      const lines = content.split('\n');
      if (lines.length <= maxLines) {
        return `**文件内容预览:**\n\`\`\`\n${content}\n\`\`\``;
      }

      const preview = lines.slice(0, maxLines).join('\n');
      return `**文件内容预览 (前 ${maxLines} 行):**\n\`\`\`\n${preview}\n\`\`\`\n\n... (还有 ${lines.length - maxLines} 行)`;
    }
    default:
      return undefined;
  }
}

/** Risk hints shown with a confirmation prompt, derived from the pending call. */
export function extractRisksFromPermissionCheck(
  tool: { name: string },
  params: JsonObject,
  permissionCheckResult?: { reason?: string },
): string[] {
  const risks: string[] = [];

  if (permissionCheckResult?.reason) {
    risks.push(permissionCheckResult.reason);
  }

  if (tool.name === 'Bash') {
    const command = getString(params, 'command');
    const mainCommand = command.trim().split(/\s+/)[0];

    if (['cat', 'head', 'tail'].includes(mainCommand)) {
      risks.push(`💡 建议使用 Read 工具代替 ${mainCommand} 命令`);
    } else if (['grep', 'rg'].includes(mainCommand)) {
      risks.push('💡 建议使用 Grep 工具代替 grep/rg 命令');
    } else if (mainCommand === 'find') {
      risks.push('💡 建议使用 Glob 工具代替 find 命令');
    } else if (['sed', 'awk'].includes(mainCommand)) {
      risks.push(`💡 建议使用 Edit 工具代替 ${mainCommand} 命令`);
    }

    if (command.includes('rm')) risks.push('⚠️ 此命令可能删除文件');
    if (command.includes('sudo')) risks.push('⚠️ 此命令需要管理员权限');
    if (command.includes('git push')) risks.push('⚠️ 此命令将推送代码到远程仓库');
  } else if (['Write', 'Edit'].includes(tool.name)) {
    risks.push('此操作将修改文件内容');
  } else if (tool.name === 'Delete') {
    risks.push('此操作将永久删除文件');
  }

  return risks;
}
