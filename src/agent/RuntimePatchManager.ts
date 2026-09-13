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
import type { ConversationMessage } from '../model/conversation.js';
import type { ModelMessage } from '../model/message.js';
import {
  type ContextSnapshot,
  createContextSnapshot,
  mergeContext,
  type RuntimeContext,
  type RuntimeContextPatch,
  type RuntimePatch,
  type RuntimePatchApplication,
  type RuntimePatchProvenance,
  summarizeRuntimePatchApplications,
} from '../runtime/index.js';
import type { SkillActivationContext } from '../skills/index.js';
import type { ToolDiscoveryEntry } from '../tools/exposure/index.js';
import type { ToolEffect } from '../tools/types/effects.js';
import { getRuntimePatchEffect } from '../tools/types/effects.js';
import type { SessionId } from '../types/identifiers.js';
import type { ConversationState } from './state/ConversationState.js';
import type { LoopState } from './state/LoopState.js';
import type { LoopSkillState } from './state/TurnState.js';

export class RuntimePatchManager {
  /**
   * Skill identities are held per layer like the rest of the scoped state: a
   * turn-scoped Skill is the active identity for that turn, and cleanup must
   * reveal the session-scoped Skill that is still applied rather than report none.
   */
  private sessionSkillState?: LoopSkillState;
  private turnSkillState?: LoopSkillState;
  private runtimeSkillState?: LoopSkillState;
  /**
   * The session-scoped policy, kept separately from the effective one. A turn patch
   * overrides it for the duration of the turn and must not erase it on cleanup.
   */
  private sessionToolPolicy?: {
    allow?: string[];
    deny?: string[];
  };
  private runtimeToolPolicy?: {
    allow?: string[];
    deny?: string[];
    scope: 'turn' | 'session';
  };
  /**
   * Context overlays are held per layer for the same reason as the other state
   * above: a turn-scoped overlay is merged on top of the session's for one turn,
   * and dropping it must restore the session overlay instead of removing every
   * context contribution.
   */
  private sessionContextOverlay?: RuntimeContext;
  private turnContextOverlay?: RuntimeContext;
  /**
   * Session-scoped tool discoveries, kept separately from the effective set for
   * the same reason as `sessionToolPolicy`: a turn patch contributes to the
   * effective set for one turn and must not take the session's discoveries with it
   * when the turn is cleaned up.
   */
  private sessionDiscoveredTools?: Set<string>;
  private turnDiscoveredTools?: Set<string>;
  private runtimeDiscoveredTools?: {
    values: Set<string>;
    scope: 'turn' | 'session';
  };
  private runtimeHookRegistrations: Array<{ registrationId: string; scope: 'turn' | 'session' }> =
    [];
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
    if (!ctx) {
      this.sessionSkillState = undefined;
      this.turnSkillState = undefined;
    } else if ((ctx.scope ?? 'session') === 'turn') {
      this.turnSkillState = ctx;
    } else {
      this.sessionSkillState = ctx;
    }
    this.recomputeSkillState();
    this.runtimeToolPolicy = ctx
      ? {
          allow: ctx.allowedTools,
          deny: ctx.deniedTools,
          scope: ctx.scope ?? 'session',
        }
      : this.sessionToolPolicy
        ? { ...this.sessionToolPolicy, scope: 'session' }
        : undefined;
  }

  /**
   * Deactivate the Skill that is currently active. The other layer stays: clearing
   * a temporary Skill must not deactivate the session Skill underneath it, and an
   * explicit deactivation must not erase a baseline it never set.
   */
  clearSkillContext(): void {
    const deactivated = this.turnSkillState ?? this.sessionSkillState;
    if (deactivated) {
      this.logger.debug(`🎯 Skill "${deactivated.skillName}" deactivated`);
    }
    if (this.turnSkillState) {
      this.turnSkillState = undefined;
    } else {
      this.sessionSkillState = undefined;
    }
    this.recomputeSkillState();
    this.runtimeToolPolicy = this.sessionToolPolicy
      ? { ...this.sessionToolPolicy, scope: 'session' }
      : undefined;
  }

  private recomputeSkillState(): void {
    this.runtimeSkillState = this.turnSkillState ?? this.sessionSkillState;
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

  deriveRuntimePatch(result: {
    status: 'success' | 'error';
    effects?: ToolEffect[];
  }): RuntimePatch | undefined {
    if (result.status === 'error') {
      return undefined;
    }

    const effectRuntimePatch = getRuntimePatchEffect(result.effects);
    if (effectRuntimePatch) {
      return effectRuntimePatch;
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
      if (patch.scope === 'session') {
        this.sessionToolPolicy = { allow: patch.toolPolicy.allow, deny: patch.toolPolicy.deny };
      }
      this.runtimeToolPolicy = {
        allow: patch.toolPolicy.allow,
        deny: patch.toolPolicy.deny,
        scope: patch.scope,
      };
    } else if (patch.skill) {
      // A skill patch without an explicit toolPolicy keeps the effective policy
      // at the session baseline. Recording the baseline with the patch's scope —
      // instead of clearing the field — is what lets turn cleanup restore the
      // session patch even though the effective field no longer carries a turn
      // scope. An empty field cannot decide which baseline to recover.
      this.runtimeToolPolicy = this.sessionToolPolicy
        ? { ...this.sessionToolPolicy, scope: patch.scope }
        : undefined;
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
      if (patch.scope === 'session') {
        this.sessionSkillState = nextSkillContext;
      } else {
        this.turnSkillState = nextSkillContext;
      }
      this.recomputeSkillState();
      loopState.setActiveSkill(nextSkillContext);
    }
  }

  // ===== Context Patch =====

  applyRuntimeContextPatch(patch: RuntimeContextPatch): void {
    if (patch.reset) {
      // A reset clears the layer that declared it; the other layer's overlay is
      // still in effect.
      if (patch.scope === 'session') {
        this.sessionContextOverlay = undefined;
      } else {
        this.turnContextOverlay = undefined;
      }
    }

    if (!patch.context) {
      return;
    }

    if (patch.scope === 'session') {
      this.sessionContextOverlay = mergeContext(this.sessionContextOverlay, patch.context);
    } else {
      this.turnContextOverlay = mergeContext(this.turnContextOverlay, patch.context);
    }
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
    sessionId: SessionId,
    snapshot?: ContextSnapshot,
  ): ContextSnapshot | undefined {
    const summary = summarizeRuntimePatchApplications(this.runtimePatchApplications);
    if (!summary.mergedEnvironment && !this.sessionContextOverlay && !this.turnContextOverlay) {
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

    if (this.sessionContextOverlay) {
      mergedContext = mergeContext(mergedContext, this.sessionContextOverlay);
    }

    if (this.turnContextOverlay) {
      mergedContext = mergeContext(mergedContext, this.turnContextOverlay);
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
    const segments = [baseAppend?.trim(), summary.mergedPromptAppend].filter(
      (segment): segment is string => Boolean(segment),
    );

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

    return prompt.trim() ? `${prompt}\n\n---\n\n${runtimeAppend}` : runtimeAppend;
  }

  // ===== Skill Activation Context =====

  createSkillActivationContext(
    cwd: string | undefined,
    messages: readonly ModelMessage[],
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
    if (patch.toolDiscovery?.reset) {
      // A reset clears the layer that declared it; the other layer's discoveries
      // stay in effect and are re-derived below.
      if (patch.scope === 'session') {
        this.sessionDiscoveredTools = undefined;
      } else {
        this.turnDiscoveredTools = undefined;
      }
    }

    const discovered = patch.toolDiscovery?.discover
      ?.filter(
        (toolName): toolName is string => typeof toolName === 'string' && toolName.trim() !== '',
      )
      .map((toolName) => toolName.trim());
    if (discovered && discovered.length > 0) {
      if (patch.scope === 'session') {
        this.sessionDiscoveredTools ??= new Set<string>();
        for (const toolName of discovered) {
          this.sessionDiscoveredTools.add(toolName);
        }
      } else {
        this.turnDiscoveredTools ??= new Set<string>();
        for (const toolName of discovered) {
          this.turnDiscoveredTools.add(toolName);
        }
      }
    }

    this.recomputeDiscoveredTools();
  }

  /**
   * Re-derive the effective discovery set from the two layers.
   *
   * Each layer keeps its own contributions: merging them into one set and stamping
   * it with the last patch's scope would make turn cleanup drop the session's
   * discoveries, and a reset in one layer would erase the other layer's tools.
   */
  private recomputeDiscoveredTools(): void {
    const merged = new Set([
      ...(this.sessionDiscoveredTools ?? []),
      ...(this.turnDiscoveredTools ?? []),
    ]);
    if (merged.size === 0) {
      this.runtimeDiscoveredTools = undefined;
      return;
    }
    this.runtimeDiscoveredTools = {
      values: merged,
      scope: (this.turnDiscoveredTools?.size ?? 0) > 0 ? 'turn' : 'session',
    };
  }

  syncDiscoverableToolsCatalogMessage(
    convState: ConversationState,
    discoverableTools: ToolDiscoveryEntry[],
  ): void {
    const existingIndex = convState.findIndex(
      (message) =>
        message.role === 'system' &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            part.type === 'text' &&
            part.text.includes(RuntimePatchManager.DISCOVERABLE_TOOLS_MARKER),
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
      .map(
        (tool) =>
          `- ${tool.name}: ${tool.description}${tool.discoveryHint ? ` (${tool.discoveryHint})` : ''}`,
      )
      .join('\n');

    const content = [
      {
        type: 'text' as const,
        text: `${RuntimePatchManager.DISCOVERABLE_TOOLS_MARKER}
Additional tools are available but not currently loaded into the function list.
Use the DiscoverTools tool to search and activate them for later turns in this conversation.

Currently discoverable tools:
${summary}`,
      },
    ];

    const catalogMessage: ConversationMessage = {
      role: 'system',
      content,
      provenance: { source: 'catalog' },
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
      // Restore the session baseline instead of clearing: an empty effective policy
      // would report no restriction while the patch history still claims one.
      this.runtimeToolPolicy = this.sessionToolPolicy
        ? { ...this.sessionToolPolicy, scope: 'session' }
        : undefined;
    }
    if (this.turnSkillState) {
      // Reveal the session Skill instead of reporting that no Skill is active: its
      // patches are still applied and its prompt is still in effect.
      this.turnSkillState = undefined;
      this.recomputeSkillState();
    }
    if (this.turnContextOverlay) {
      // Drop only the turn layer: the session's context contribution is not the
      // turn's to drop, and the effective snapshot is re-derived from what is left.
      this.turnContextOverlay = undefined;
    }
    if (this.turnDiscoveredTools) {
      // Drop only the turn layer: the session's discoveries are not the turn's to
      // drop, so the effective set is re-derived instead of cleared.
      this.turnDiscoveredTools = undefined;
      this.recomputeDiscoveredTools();
    }
    this.runtimePatchApplications = this.runtimePatchApplications.filter(
      (application) => application.patch.scope !== 'turn',
    );
    if (this.hookRuntime && this.runtimeHookRegistrations.length > 0) {
      const turnScopedRegistrations = this.runtimeHookRegistrations
        .filter((registration) => registration.scope === 'turn')
        .map((registration) => registration.registrationId);
      if (turnScopedRegistrations.length > 0) {
        this.hookRuntime.unregisterRuntimeHooks(turnScopedRegistrations);
        this.runtimeHookRegistrations = this.runtimeHookRegistrations.filter(
          (registration) => registration.scope !== 'turn',
        );
      }
    }
  }

  // ===== 内部辅助 =====

  /**
   * A skill patch that carries no prompt append / environment resets that
   * contribution for its own layer.
   *
   * Only applications from the same scope are pruned. The prompt and environment
   * baselines live in this application list — unlike the tool policy, they have no
   * separate session field — so pruning across scopes would delete the session
   * baseline that turn cleanup is supposed to fall back to, with nothing left to
   * re-derive it from.
   */
  private pruneRuntimePatchApplicationsForReset(patch: RuntimePatch): void {
    if (!patch.skill) {
      return;
    }

    const shouldResetPromptAppend =
      typeof patch.systemPromptAppend !== 'string' || patch.systemPromptAppend.trim() === '';
    const shouldResetEnvironment =
      !patch.environment || Object.keys(patch.environment).length === 0;

    if (!shouldResetPromptAppend && !shouldResetEnvironment) {
      return;
    }

    this.runtimePatchApplications = this.runtimePatchApplications.filter((application) => {
      if (application.patch.scope !== patch.scope) {
        return true;
      }
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
