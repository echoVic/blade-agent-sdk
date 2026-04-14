/**
 * RuntimePatchManager — 运行时补丁生命周期管理
 *
 * 从 LoopRunner 提取，职责：
 * - 管理运行时状态（skill、tool policy、context overlay、discovered tools、hooks、patch history）
 * - 派生和应用 RuntimePatch
 * - 构建运行时上下文快照
 * - 管理 Skill 激活/清除
 * - 管理工具发现和目录消息同步
 * - 清理 turn-scoped 状态
 */

import { analyzeFiles } from '../context/FileAnalyzer.js';
import type { HookRuntime } from '../hooks/HookRuntime.js';
import type { InternalLogger } from '../logging/Logger.js';
import {
  createContextSnapshot,
  mergeContext,
  summarizeRuntimePatchApplications,
  type ContextSnapshot,
  type RuntimeContext,
  type RuntimeContextPatch,
  type RuntimePatch,
  type RuntimePatchApplication,
  type RuntimePatchProvenance,
} from '../runtime/index.js';
import type { Message } from '../services/ChatServiceInterface.js';
import type { SkillActivationContext } from '../skills/index.js';
import type { ToolDiscoveryEntry } from '../tools/exposure/index.js';
import {
  getRuntimePatchEffect,
  type ToolEffect,
} from '../tools/types/index.js';
import type { ConversationState } from './state/ConversationState.js';
import type { LoopState } from './state/LoopState.js';
import type { LoopSkillState } from './state/TurnState.js';

export class RuntimePatchManager {
  private runtimeSkillState?: LoopSkillState;
  private runtimeToolPolicy?: {
    allow?: string[];
    deny?: string[];
    scope: 'turn' | 'session';
  };
  private runtimeContextOverlay?: {
    value: RuntimeContext;
    scope: 'turn' | 'session';
  };
  private runtimeDiscoveredTools?: {
    values: Set<string>;
    scope: 'turn' | 'session';
  };
  private runtimeHookRegistrations: Array<{ registrationId: string; scope: 'turn' | 'session' }> = [];
  private runtimePatchApplications: RuntimePatchApplication[] = [];

  private static readonly DISCOVERABLE_TOOLS_MARKER = '[discoverable-tools-catalog]';

  constructor(
    private readonly hookRuntime: HookRuntime | undefined,
    private readonly logger: InternalLogger,
  ) {}

  // ===== Skill 管理 =====

  get skillContext(): LoopSkillState | undefined {
    return this.runtimeSkillState;
  }

  setSkillContext(ctx: LoopSkillState | undefined): void {
    this.runtimeSkillState = ctx;
    this.runtimeToolPolicy = ctx
      ? {
          allow: ctx.allowedTools,
          deny: ctx.deniedTools,
          scope: ctx.scope ?? 'session',
        }
      : undefined;
  }

  clearSkillContext(): void {
    if (this.runtimeSkillState) {
      this.logger.debug(`🎯 Skill "${this.runtimeSkillState.skillName}" deactivated`);
      this.runtimeSkillState = undefined;
    }
    this.runtimeToolPolicy = undefined;
  }

  // ===== RuntimePatch 派生与应用 =====

  getRuntimePatchApplications(): RuntimePatchApplication[] {
    return this.runtimePatchApplications.map((application) => ({
      patch: { ...application.patch },
      provenance: { ...application.provenance },
    }));
  }

  get runtimeToolPolicySnapshot() {
    return this.runtimeToolPolicy;
  }

  get discoveredTools(): Set<string> | undefined {
    return this.runtimeDiscoveredTools?.values;
  }

  deriveRuntimePatch(
    result: {
      success: boolean;
      runtimePatch?: RuntimePatch;
      effects?: ToolEffect[];
    },
  ): RuntimePatch | undefined {
    if (!result.success) {
      return undefined;
    }

    const effectRuntimePatch = getRuntimePatchEffect(result.effects);
    if (effectRuntimePatch) {
      return effectRuntimePatch;
    }

    if (result.runtimePatch) {
      return result.runtimePatch;
    }
    return undefined;
  }

  applyRuntimePatch(
    patch: RuntimePatch,
    loopState: LoopState,
    provenance?: Omit<RuntimePatchProvenance, 'appliedAt'>,
  ): void {
    this.pruneRuntimePatchApplicationsForReset(patch);
    this.runtimePatchApplications.push({
      patch: { ...patch },
      provenance: {
        ...provenance,
        appliedAt: Date.now(),
      },
    });

    if (patch.toolPolicy) {
      this.runtimeToolPolicy = {
        allow: patch.toolPolicy.allow,
        deny: patch.toolPolicy.deny,
        scope: patch.scope,
      };
    } else if (patch.skill) {
      this.runtimeToolPolicy = undefined;
    }

    this.applyRuntimeToolDiscovery(patch);
    this.refreshRuntimeContextSnapshot(loopState);

    if (patch.hooks && patch.hooks.length > 0 && this.hookRuntime) {
      const registrationIds = this.hookRuntime.registerRuntimeHooks(patch.hooks);
      this.runtimeHookRegistrations.push(
        ...registrationIds.map((registrationId) => ({
          registrationId,
          scope: patch.scope,
        })),
      );
    }

    if (patch.skill) {
      const nextSkillContext: LoopSkillState = {
        skillId: patch.skill.id,
        skillName: patch.skill.name,
        allowedTools: patch.toolPolicy?.allow,
        deniedTools: patch.toolPolicy?.deny,
        basePath: patch.skill.basePath,
        scope: patch.scope,
      };
      this.runtimeSkillState = nextSkillContext;
      loopState.setActiveSkill(nextSkillContext);
      loopState.setTransitionReason('skill_activated');
    }
  }

  // ===== Context Patch =====

  applyRuntimeContextPatch(patch: RuntimeContextPatch): void {
    if (patch.reset) {
      this.runtimeContextOverlay = undefined;
    }

    if (!patch.context) {
      return;
    }

    this.runtimeContextOverlay = {
      value: patch.context,
      scope: patch.scope,
    };
  }

  refreshRuntimeContextSnapshot(loopState: LoopState): void {
    loopState.setContextSnapshot(
      this.buildRuntimeContextSnapshot(
        loopState.executionContext.sessionId,
        loopState.getBaseContextSnapshot(),
      ),
    );
  }

  // ===== Context Snapshot 构建 =====

  buildRuntimeContextSnapshot(
    sessionId: string,
    snapshot?: ContextSnapshot,
  ): ContextSnapshot | undefined {
    const summary = summarizeRuntimePatchApplications(this.runtimePatchApplications);
    if (!summary.mergedEnvironment && !this.runtimeContextOverlay) {
      return snapshot;
    }

    const mergedContext = this.mergeRuntimeContextOverlays(
      snapshot?.context,
      summary.mergedEnvironment,
    );

    return createContextSnapshot(
      snapshot?.sessionId ?? sessionId,
      snapshot?.turnId ?? 'runtime-overlay',
      mergedContext,
    );
  }

  private mergeRuntimeContextOverlays(
    baseContext?: RuntimeContext,
    mergedEnvironment?: Record<string, string>,
  ): RuntimeContext {
    let mergedContext = baseContext ?? {};

    if (this.runtimeContextOverlay?.value) {
      mergedContext = mergeContext(mergedContext, this.runtimeContextOverlay.value);
    }

    if (mergedEnvironment) {
      mergedContext = mergeContext(mergedContext, {
        environment: mergedEnvironment,
      });
    }

    return mergedContext;
  }

  // ===== System Prompt 辅助 =====

  getEffectiveSystemPromptAppend(baseAppend?: string): string | undefined {
    const summary = summarizeRuntimePatchApplications(this.runtimePatchApplications);
    const segments = [
      baseAppend?.trim(),
      summary.mergedPromptAppend,
    ].filter((segment): segment is string => Boolean(segment));

    if (segments.length === 0) {
      return undefined;
    }

    return segments.join('\n\n---\n\n');
  }

  appendRuntimeSystemPrompt(prompt: string): string {
    const runtimeAppend = summarizeRuntimePatchApplications(
      this.runtimePatchApplications,
    ).mergedPromptAppend;
    if (!runtimeAppend) {
      return prompt;
    }

    return prompt.trim()
      ? `${prompt}\n\n---\n\n${runtimeAppend}`
      : runtimeAppend;
  }

  // ===== Skill Activation Context =====

  createSkillActivationContext(
    cwd: string | undefined,
    messages: readonly Message[],
  ): SkillActivationContext {
    // skill activation 仅基于用户/助手/工具对话内容做文件引用分析，
    // 排除 system 消息（catalog、tool_injection、compaction_summary 等）避免行为漂移。
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');
    return {
      cwd,
      referencedPaths: analyzeFiles(nonSystemMessages).map((reference) => reference.path),
    };
  }

  // ===== Tool Discovery =====

  private applyRuntimeToolDiscovery(patch: RuntimePatch): void {
    const nextDiscoveredTools = patch.toolDiscovery?.discover
      ?.filter((toolName): toolName is string => typeof toolName === 'string' && toolName.trim() !== '')
      .map((toolName) => toolName.trim());

    if (patch.toolDiscovery?.reset) {
      this.runtimeDiscoveredTools = undefined;
    }

    if (!nextDiscoveredTools || nextDiscoveredTools.length === 0) {
      return;
    }

    const current = this.runtimeDiscoveredTools?.values
      ? new Set(this.runtimeDiscoveredTools.values)
      : new Set<string>();
    for (const toolName of nextDiscoveredTools) {
      current.add(toolName);
    }

    this.runtimeDiscoveredTools = {
      values: current,
      scope: patch.scope,
    };
  }

  syncDiscoverableToolsCatalogMessage(
    convState: ConversationState,
    discoverableTools: ToolDiscoveryEntry[],
  ): void {
    const existingIndex = convState.findIndex((message) =>
      message.role === 'system'
      && Array.isArray(message.content)
      && message.content.some(
        (part) => part.type === 'text'
          && part.text.includes(RuntimePatchManager.DISCOVERABLE_TOOLS_MARKER),
      ),
    );

    if (discoverableTools.length === 0) {
      if (existingIndex >= 0) {
        convState.removeAt(existingIndex);
      }
      return;
    }

    const summary = discoverableTools
      .slice(0, 12)
      .map((tool) => `- ${tool.name}: ${tool.description}${tool.discoveryHint ? ` (${tool.discoveryHint})` : ''}`)
      .join('\n');

    const content = [{
      type: 'text' as const,
      text: `${RuntimePatchManager.DISCOVERABLE_TOOLS_MARKER}
Additional tools are available but not currently loaded into the function list.
Use the DiscoverTools tool to search and activate them for later turns in this conversation.

Currently discoverable tools:
${summary}`,
    }];

    const catalogMessage: Message = {
      role: 'system',
      content,
      metadata: { _systemSource: 'catalog' },
    };

    if (existingIndex >= 0) {
      convState.replaceAt(existingIndex, catalogMessage);
      return;
    }

    convState.insertAfterSystemBlock(catalogMessage);
  }

  // ===== Turn-scoped 状态清理 =====

  clearTurnScopedRuntimeState(): void {
    if (this.runtimeToolPolicy?.scope === 'turn') {
      this.runtimeToolPolicy = undefined;
    }
    if (this.runtimeSkillState?.scope === 'turn') {
      this.runtimeSkillState = undefined;
    }
    if (this.runtimeContextOverlay?.scope === 'turn') {
      this.runtimeContextOverlay = undefined;
    }
    if (this.runtimeDiscoveredTools?.scope === 'turn') {
      this.runtimeDiscoveredTools = undefined;
    }
    this.runtimePatchApplications = this.runtimePatchApplications
      .filter((application) => application.patch.scope !== 'turn');
    if (this.hookRuntime && this.runtimeHookRegistrations.length > 0) {
      const turnScopedRegistrations = this.runtimeHookRegistrations
        .filter((registration) => registration.scope === 'turn')
        .map((registration) => registration.registrationId);
      if (turnScopedRegistrations.length > 0) {
        this.hookRuntime.unregisterRuntimeHooks(turnScopedRegistrations);
        this.runtimeHookRegistrations = this.runtimeHookRegistrations
          .filter((registration) => registration.scope !== 'turn');
      }
    }
  }

  // ===== 内部辅助 =====

  private pruneRuntimePatchApplicationsForReset(patch: RuntimePatch): void {
    if (!patch.skill) {
      return;
    }

    const shouldResetPromptAppend = typeof patch.systemPromptAppend !== 'string'
      || patch.systemPromptAppend.trim() === '';
    const shouldResetEnvironment = !patch.environment
      || Object.keys(patch.environment).length === 0;

    if (!shouldResetPromptAppend && !shouldResetEnvironment) {
      return;
    }

    this.runtimePatchApplications = this.runtimePatchApplications.filter((application) => {
      if (shouldResetPromptAppend && application.patch.systemPromptAppend) {
        return false;
      }
      if (shouldResetEnvironment && application.patch.environment) {
        return false;
      }
      return true;
    });
  }
}
