import { z } from 'zod';
import type { RuntimeHookEvent, RuntimeHookRegistration } from '../../../runtime/index.js';
import { getSkillRegistry, isSkillAvailableInContext } from '../../../skills/index.js';
import type { SkillContent } from '../../../skills/types.js';
import { HookEvent } from '../../../types/constants.js';
import { createTool } from '../../core/createTool.js';
import { getEffectiveProjectDir } from '../../types/ExecutionTypes.js';
import { ToolKind } from '../../types/ToolKind.js';
import type { ToolResult } from '../../types/ToolResult.js';
import { ToolErrorType } from '../../types/ToolResult.js';
import { lazySchema } from '../../validation/lazySchema.js';

/**
 * Skill tool
 * Execute a skill within the main conversation
 *
 * Skills 是动态 Prompt 扩展机制，允许 AI 根据用户请求自动调用专业能力。
 * 执行 Skill 时，返回双消息：
 * - llmContent: 完整的 Skill 指令（发送给 LLM）
 * - metadata.summary: 简短的加载提示
 */
export const skillTool = createTool({
  name: 'Skill',
  displayName: 'Skill',
  kind: ToolKind.Execute,

  schema: lazySchema(() => z.object({
    skill: z
      .string()
      .describe('The skill name. E.g., "commit-message" or "code-review"'),
    args: z.string().optional().describe('Optional arguments for the skill'),
  })),

  description: {
    short: 'Execute a skill within the main conversation',
    long: `Execute a skill within the main conversation

<skills_instructions>
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

When using the Skill tool:
- Invoke skills using this tool with the skill name only
- When you invoke a skill, you will see <command-message>The "{name}" skill is loading</command-message>
- The skill's prompt will expand and provide detailed instructions on how to complete the task

Important:
- Only use skills listed in <available_skills> below
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
</skills_instructions>

<available_skills>

</available_skills>
`,
  },

  async execute(params, context): Promise<ToolResult> {
    const { skill, args } = params;

    // 获取 SkillRegistry
    const registry = getSkillRegistry();
    const skillMetadata = registry.get(skill);

    // 检查 skill 是否存在
    if (!skillMetadata) {
      return {
        success: false,
        llmContent: `Skill "${skill}" not found. Available skills: ${
          registry
            .getAll()
            .map((s) => s.name)
            .join(', ') || 'none'
        }`,
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: `Skill "${skill}" is not registered`,
        },
        metadata: {
          summary: '未找到 Skill',
        },
      };
    }

    const cwd = getEffectiveProjectDir(context);
    const activationAllowed = isSkillAvailableInContext(skillMetadata, {
      cwd,
      referencedPaths: context.skillActivationPaths,
      args,
    });
    if (!activationAllowed) {
      const requiredPaths = skillMetadata.conditions?.paths?.join(', ') || 'unknown';
      return {
        success: false,
        llmContent: `Skill "${skill}" is not available in the current context. Required path conditions: ${requiredPaths}`,
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: `Skill "${skill}" conditions are not satisfied`,
        },
        metadata: {
          summary: 'Skill 不可用',
        },
      };
    }

    // 加载完整的 Skill 内容，传入 cwd 以支持内联命令替换（!`command` 语法）
    const content = await registry.loadContent(skill, { cwd, args });
    if (!content) {
      return {
        success: false,
        llmContent: `Failed to load skill "${skill}" content`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: `Could not read SKILL.md for "${skill}"`,
        },
        metadata: {
          summary: 'Skill 加载失败',
        },
      };
    }

    // 构建完整的 Skill 指令（发送给 LLM）
    const skillInstructions = buildSkillInstructions(
      content.metadata.name,
      content.instructions,
      content.metadata.basePath,
      content.assets,
      args
    );
    const requestedModelId =
      content.metadata.runtimeEffects?.modelId;
    const runtimeHooks = compileRuntimeHooks(content);
    const runtimePatch = {
      scope: content.metadata.runtimeEffects?.activeScope ?? 'session',
      source: 'skill' as const,
      skill: {
        id: content.metadata.name,
        name: content.metadata.name,
        basePath: content.metadata.basePath,
      },
      toolPolicy: {
        allow: content.metadata.runtimeEffects?.allowedTools ?? content.metadata.allowedTools,
        deny: content.metadata.runtimeEffects?.deniedTools ?? content.metadata.disallowedTools,
      },
      modelOverride: requestedModelId
        ? {
            modelId: requestedModelId,
            effort: content.metadata.runtimeEffects?.effort,
          }
        : undefined,
      systemPromptAppend: content.metadata.runtimeEffects?.systemPromptAppend,
      environment: content.metadata.runtimeEffects?.environment,
      hooks: runtimeHooks,
    };

    // 返回双消息
    return {
      success: true,
      llmContent: skillInstructions,
      effects: [
        {
          type: 'runtimePatch',
          patch: runtimePatch,
        },
      ],
      metadata: {
        skillId: content.metadata.name,
        skillName: skill,
        basePath: content.metadata.basePath,
        version: content.metadata.version,
        summary: `加载 Skill: ${skill}`,
      },
      runtimePatch,
    };
  },
});

function compileRuntimeHooks(content: SkillContent): RuntimeHookRegistration[] | undefined {
  if (!content.hooks || content.hooks.length === 0) {
    return undefined;
  }

  if (content.metadata.source.hookPolicy === 'deny') {
    return undefined;
  }

  const hooks = content.hooks.flatMap((hook): RuntimeHookRegistration[] => {
    if (!isRuntimeHookEvent(hook.event)) {
      return [];
    }

    return [{
      event: hook.event,
      type: hook.type,
      value: hook.value,
      tools: hook.tools,
      once: hook.once,
    }];
  });

  return hooks.length > 0 ? hooks : undefined;
}

function isRuntimeHookEvent(event: HookEvent): event is RuntimeHookEvent {
  return event === HookEvent.PreToolUse
    || event === HookEvent.PostToolUse
    || event === HookEvent.PostToolUseFailure
    || event === HookEvent.PermissionRequest
    || event === HookEvent.UserPromptSubmit
    || event === HookEvent.SessionStart
    || event === HookEvent.SessionEnd
    || event === HookEvent.TaskCompleted;
}

/**
 * 构建完整的 Skill 指令
 */
function buildSkillInstructions(
  name: string,
  instructions: string,
  basePath: string,
  assets: {
    scripts: Array<{ path: string }>;
    references: Array<{ path: string }>;
    templates: Array<{ path: string }>;
  },
  args?: string,
): string {
  const assetSection = [
    assets.scripts.length > 0
      ? `**Available Scripts** (invoke via Bash tool with \`${basePath}/\` prefix):\n${assets.scripts.map((asset) => `- ${asset.path}`).join('\n')}`
      : '',
    assets.references.length > 0
      ? `**References**:\n${assets.references.map((asset) => `- ${asset.path}`).join('\n')}`
      : '',
    assets.templates.length > 0
      ? `**Templates**:\n${assets.templates.map((asset) => `- ${asset.path}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');

  const argsSection = args
    ? `\n**Invocation Arguments:** ${args}\n`
    : '';

  return `# Skill: ${name}

You are now operating in the "${name}" skill mode. Follow the instructions below to complete the task.

**Skill Base Path:** ${basePath}
(You can reference scripts, templates, and references relative to this path)
${argsSection}${assetSection ? `\n\n${assetSection}\n` : ''}
---

${instructions}

---

Remember: Follow the above instructions carefully to complete the user's request.`;
}
