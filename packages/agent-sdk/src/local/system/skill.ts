import { z } from 'zod';
import { createTool, ToolErrorType, ToolKind } from '../../tools/index.js';
import type { ExecutionContext, ToolResult } from '../../tools/types/index.js';

// ---------------------------------------------------------------------------
// Skill system port (decouples from root skill infrastructure)
// ---------------------------------------------------------------------------

interface SkillSource {
  kind: string;
  trustLevel: string;
  sourceId: string;
  rootDir?: string;
  precedence: number;
  shellPolicy: string;
  hookPolicy: string;
}

interface SkillRuntimeEffects {
  allowedTools?: string[];
  deniedTools?: string[];
  modelId?: string;
  effort?: number | string;
  systemPromptAppend?: string;
  environment?: Record<string, string>;
  activeScope?: 'turn' | 'session';
}

interface SkillActivationConditions {
  paths?: string[];
}

interface SkillMetadata {
  name: string;
  version?: string;
  description?: string;
  basePath: string;
  source: SkillSource;
  runtimeEffects?: SkillRuntimeEffects;
  allowedTools?: string[];
  disallowedTools?: string[];
  conditions?: SkillActivationConditions;
}

interface SkillHookSpec {
  event: string;
  type: string;
  value?: string;
  tools?: string[];
  once?: boolean;
}

interface SkillContent {
  metadata: SkillMetadata;
  instructions: string;
  assets: {
    scripts: Array<{ path: string }>;
    references: Array<{ path: string }>;
    templates: Array<{ path: string }>;
  };
  hooks?: SkillHookSpec[];
}

interface SkillRegistryPort {
  get(name: string): SkillMetadata | undefined;
  getAll(): SkillMetadata[];
  loadContent(name: string, opts: { cwd?: string; args?: string }): Promise<SkillContent | null>;
}

import picomatch from 'picomatch';

// ... (keep all code before isSkillAvailableInContext)

function extractPathCandidatesFromArgs(args?: string): string[] {
  if (!args) return [];
  // Extract path-like substrings (words containing / or . that look like paths)
  const tokens = args.match(/\S+/g) ?? [];
  return tokens.filter((t) => t.includes('/') || t.includes('.'));
}

function isSkillAvailableInContext(
  skillMetadata: SkillMetadata,
  context: { cwd?: string; referencedPaths?: string[]; args?: string },
): boolean {
  const patterns = skillMetadata.conditions?.paths?.map((p) => p.trim()).filter(Boolean);
  if (!patterns || patterns.length === 0) return true;

  const rawCandidates = [
    ...(context.referencedPaths ?? []),
    ...extractPathCandidatesFromArgs(context.args),
  ];

  const candidates = rawCandidates.map((c) => c.trim()).filter(Boolean);

  if (candidates.length === 0) return false;

  const matchers = patterns.map((pattern) => picomatch(pattern, { dot: true }));
  return candidates.some((candidate) => matchers.some((matcher) => matcher(candidate)));
}

// ---------------------------------------------------------------------------
// Runtime hook types (subset of root runtime/index.js)
// ---------------------------------------------------------------------------

interface RuntimeHookRegistration {
  event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PermissionRequest'
    | 'UserPromptSubmit' | 'SessionStart' | 'SessionEnd' | 'TaskCompleted';
  type: string;
  value?: string;
  tools?: string[];
  once?: boolean;
}

function isRuntimeHookEvent(event: string): event is RuntimeHookRegistration['event'] {
  return [
    'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
    'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'TaskCompleted',
  ].includes(event);
}

function compileRuntimeHooks(content: SkillContent): RuntimeHookRegistration[] | undefined {
  if (!content.hooks || content.hooks.length === 0) return undefined;

  if (content.metadata.source.hookPolicy === 'deny') return undefined;

  const hooks = content.hooks.flatMap((hook): RuntimeHookRegistration[] => {
    if (!isRuntimeHookEvent(hook.event)) return [];
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

// ---------------------------------------------------------------------------
// Skill instructions builder
// ---------------------------------------------------------------------------

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
      ? `**Available Scripts** (invoke via Bash tool with \`${basePath}/\` prefix):\n${assets.scripts.map((a) => `- ${a.path}`).join('\n')}`
      : '',
    assets.references.length > 0
      ? `**References**:\n${assets.references.map((a) => `- ${a.path}`).join('\n')}`
      : '',
    assets.templates.length > 0
      ? `**Templates**:\n${assets.templates.map((a) => `- ${a.path}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');

  const argsSection = args ? `\n**Invocation Arguments:** ${args}\n` : '';

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

// ---------------------------------------------------------------------------
// Skill tool
// ---------------------------------------------------------------------------

const skillSchema = z.object({
  skill: z.string().describe('The skill name. E.g., "commit-message" or "code-review"'),
  args: z.string().optional().describe('Optional arguments for the skill'),
});

export const skillTool = createTool({
  name: 'Skill',
  displayName: 'Skill',
  kind: ToolKind.Execute,

  schema: skillSchema,

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

  async execute(params, context: ExecutionContext): Promise<ToolResult> {
    const { skill, args } = params;

    const registry = (context as Record<string, unknown>).skillRegistry as SkillRegistryPort | undefined;
    if (!registry) {
      return {
        success: false,
        llmContent: 'Skill system is not available (no skill registry configured).',
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: 'Skill registry is unavailable',
        },
        metadata: { summary: 'Skill 系统不可用' },
      };
    }

    const skillMetadata = registry.get(skill);
    if (!skillMetadata) {
      const available = registry.getAll().map((s) => s.name).join(', ') || 'none';
      return {
        success: false,
        llmContent: `Skill "${skill}" not found. Available skills: ${available}`,
        error: {
          type: ToolErrorType.VALIDATION_ERROR,
          message: `Skill "${skill}" is not registered`,
        },
        metadata: { summary: '未找到 Skill' },
      };
    }

    const cwd = (context as Record<string, unknown>).workingDirectory as string | undefined
      ?? (context as Record<string, unknown>).cwd as string | undefined;
    const activationAllowed = isSkillAvailableInContext(skillMetadata, {
      cwd,
      referencedPaths: (context as Record<string, unknown>).skillActivationPaths as string[] | undefined,
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
        metadata: { summary: 'Skill 不可用' },
      };
    }

    const content = await registry.loadContent(skill, { cwd, args });
    if (!content) {
      return {
        success: false,
        llmContent: `Failed to load skill "${skill}" content`,
        error: {
          type: ToolErrorType.EXECUTION_ERROR,
          message: `Could not read SKILL.md for "${skill}"`,
        },
        metadata: { summary: 'Skill 加载失败' },
      };
    }

    const skillInstructions = buildSkillInstructions(
      content.metadata.name,
      content.instructions,
      content.metadata.basePath,
      content.assets,
      args,
    );

    const requestedModelId = content.metadata.runtimeEffects?.modelId;
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
        ? { modelId: requestedModelId, effort: content.metadata.runtimeEffects?.effort }
        : undefined,
      systemPromptAppend: content.metadata.runtimeEffects?.systemPromptAppend,
      environment: content.metadata.runtimeEffects?.environment,
      hooks: runtimeHooks,
    };

    return {
      success: true,
      llmContent: skillInstructions,
      effects: [{ type: 'runtimePatch', patch: runtimePatch }],
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
