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
  type RuntimePatchProvenance,
  type RuntimePatchScope,
  summarizeRuntimePatchApplications,
} from '../runtime/index.js';
import type { SkillActivationContext } from '../skills/index.js';
import type { DiscoverableToolInfo } from '../tools/exposure/index.js';
import type { ToolEffect } from '../tools/types/effects.js';
import { getRuntimePatchEffect } from '../tools/types/effects.js';
import type { SessionId } from '../types/identifiers.js';
import type { ConversationState } from './state/ConversationState.js';
import type { LoopState } from './state/LoopState.js';
import type { LoopSkillState } from './state/TurnState.js';

interface RuntimeLayer {
  skill?: LoopSkillState;
  policy?: { allow?: string[]; deny?: string[] };
  context?: RuntimeContext;
  discoveries?: Set<string>;
  hookIds: string[];
}

function layer(): RuntimeLayer {
  return { hookIds: [] };
}

export class RuntimePatchManager {
  private static readonly CATALOG_MARKER = '[discoverable-tools-catalog]';
  private readonly layers: Record<RuntimePatchScope, RuntimeLayer> = {
    session: layer(),
    turn: layer(),
  };
  private applications: Array<{
    patch: RuntimePatch;
    provenance: RuntimePatchProvenance;
  }> = [];

  constructor(
    private readonly hookRuntime: HookRuntime | undefined,
    private readonly logger: InternalLogger,
  ) {}

  get skillContext(): LoopSkillState | undefined {
    return this.layers.turn.skill ?? this.layers.session.skill;
  }

  get runtimeToolPolicySnapshot():
    | { allow?: string[]; deny?: string[]; scope: RuntimePatchScope }
    | undefined {
    if (this.layers.turn.policy) return { ...this.layers.turn.policy, scope: 'turn' };
    if (this.layers.session.policy) return { ...this.layers.session.policy, scope: 'session' };
    return undefined;
  }

  get discoveredTools(): Set<string> | undefined {
    const values = new Set([
      ...(this.layers.session.discoveries ?? []),
      ...(this.layers.turn.discoveries ?? []),
    ]);
    return values.size > 0 ? values : undefined;
  }

  setSkillContext(skill: LoopSkillState | undefined): void {
    if (!skill) {
      this.layers.session.skill = undefined;
      this.layers.turn.skill = undefined;
      return;
    }
    const scope = skill.scope ?? 'session';
    this.layers[scope].skill = skill;
    this.layers[scope].policy = {
      allow: skill.allowedTools,
      deny: skill.deniedTools,
    };
  }

  clearSkillContext(): void {
    const scope = this.layers.turn.skill ? 'turn' : 'session';
    const skill = this.layers[scope].skill;
    if (skill) this.logger.debug(`🎯 Skill "${skill.skillName}" deactivated`);
    this.layers[scope].skill = undefined;
    this.layers[scope].policy = undefined;
  }

  getRuntimePatchApplications() {
    return this.applications.map((application) => ({
      patch: { ...application.patch },
      provenance: { ...application.provenance },
    }));
  }

  deriveRuntimePatch(result: {
    status: 'success' | 'error';
    effects?: ToolEffect[];
  }): RuntimePatch | undefined {
    return result.status === 'success' ? getRuntimePatchEffect(result.effects) : undefined;
  }

  applyRuntimePatch(
    patch: RuntimePatch,
    loopState: LoopState,
    provenance?: Omit<RuntimePatchProvenance, 'appliedAt'>,
  ): void {
    this.pruneResetContributions(patch);
    this.applications.push({
      patch: { ...patch },
      provenance: { ...provenance, appliedAt: Date.now() },
    });
    const target = this.layers[patch.scope];
    if (patch.toolPolicy) target.policy = { ...patch.toolPolicy };
    else if (patch.skill && patch.scope === 'turn') target.policy = undefined;
    this.applyDiscovery(target, patch);
    this.refreshRuntimeContextSnapshot(loopState);
    if (patch.hooks?.length && this.hookRuntime) {
      target.hookIds.push(...this.hookRuntime.registerRuntimeHooks(patch.hooks));
    }
    if (patch.skill) {
      target.skill = {
        skillId: patch.skill.id,
        skillName: patch.skill.name,
        allowedTools: patch.toolPolicy?.allow,
        deniedTools: patch.toolPolicy?.deny,
        basePath: patch.skill.basePath,
        scope: patch.scope,
      };
      loopState.setActiveSkill(target.skill);
    }
  }

  applyRuntimeContextPatch(patch: RuntimeContextPatch): void {
    const target = this.layers[patch.scope];
    if (patch.reset) target.context = undefined;
    if (patch.context) target.context = mergeContext(target.context, patch.context);
  }

  refreshRuntimeContextSnapshot(loopState: LoopState): void {
    loopState.setContextSnapshot(
      this.buildRuntimeContextSnapshot(
        loopState.executionContext.sessionId,
        loopState.getBaseContextSnapshot(),
      ),
    );
  }

  buildRuntimeContextSnapshot(
    sessionId: SessionId,
    snapshot?: ContextSnapshot,
  ): ContextSnapshot | undefined {
    const summary = summarizeRuntimePatchApplications(this.applications);
    if (!summary.mergedEnvironment && !this.layers.session.context && !this.layers.turn.context) {
      return snapshot;
    }
    let context = snapshot?.context ?? {};
    for (const scope of ['session', 'turn'] as const) {
      if (this.layers[scope].context) {
        context = mergeContext(context, this.layers[scope].context);
      }
    }
    if (summary.mergedEnvironment) {
      context = mergeContext(context, { environment: summary.mergedEnvironment });
    }
    return createContextSnapshot(
      snapshot?.sessionId ?? sessionId,
      snapshot?.turnId ?? 'runtime-overlay',
      context,
    );
  }

  getEffectiveSystemPromptAppend(base?: string): string | undefined {
    const runtime = summarizeRuntimePatchApplications(this.applications).mergedPromptAppend;
    const segments = [base?.trim(), runtime].filter((value): value is string => Boolean(value));
    return segments.length > 0 ? segments.join('\n\n---\n\n') : undefined;
  }

  appendRuntimeSystemPrompt(prompt: string): string {
    const append = summarizeRuntimePatchApplications(this.applications).mergedPromptAppend;
    return append ? (prompt.trim() ? `${prompt}\n\n---\n\n${append}` : append) : prompt;
  }

  createSkillActivationContext(
    cwd: string | undefined,
    messages: readonly ModelMessage[],
  ): SkillActivationContext {
    return {
      cwd,
      referencedPaths: analyzeFiles(messages.filter((message) => message.role !== 'system')).map(
        (reference) => reference.path,
      ),
    };
  }

  syncDiscoverableToolsCatalogMessage(
    conversation: ConversationState,
    tools: DiscoverableToolInfo[],
  ): void {
    const index = conversation.findIndex(
      (message) =>
        message.role === 'system' &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) => part.type === 'text' && part.text.includes(RuntimePatchManager.CATALOG_MARKER),
        ),
    );
    if (tools.length === 0) {
      if (index >= 0) conversation.removeAt(index);
      return;
    }
    const summary = tools
      .slice(0, 12)
      .map(
        (tool) =>
          `- ${tool.name}: ${tool.description}${tool.discoveryHint ? ` (${tool.discoveryHint})` : ''}`,
      )
      .join('\n');
    const message: ConversationMessage = {
      role: 'system',
      provenance: { source: 'catalog' },
      content: [
        {
          type: 'text',
          text: `${RuntimePatchManager.CATALOG_MARKER}
Additional tools are available but not currently loaded into the function list.
Use the DiscoverTools tool to search and activate them for later turns in this conversation.

Currently discoverable tools:
${summary}`,
        },
      ],
    };
    if (index >= 0) conversation.replaceAt(index, message);
    else conversation.insertAfterSystemBlock(message);
  }

  clearTurnScopedRuntimeState(): void {
    const turn = this.layers.turn;
    if (this.hookRuntime && turn.hookIds.length > 0) {
      this.hookRuntime.unregisterRuntimeHooks(turn.hookIds);
    }
    this.layers.turn = layer();
    this.applications = this.applications.filter(
      (application) => application.patch.scope !== 'turn',
    );
  }

  private applyDiscovery(target: RuntimeLayer, patch: RuntimePatch): void {
    if (patch.toolDiscovery?.reset) target.discoveries = undefined;
    const names = patch.toolDiscovery?.discover?.map((name) => name.trim()).filter(Boolean);
    if (!names?.length) return;
    target.discoveries ??= new Set();
    for (const name of names) target.discoveries.add(name);
  }

  private pruneResetContributions(patch: RuntimePatch): void {
    if (!patch.skill) return;
    const resetPrompt = !patch.systemPromptAppend?.trim();
    const resetEnvironment = !patch.environment || Object.keys(patch.environment).length === 0;
    if (!resetPrompt && !resetEnvironment) return;
    this.applications = this.applications.filter((application) => {
      if (application.patch.scope !== patch.scope) return true;
      if (resetPrompt && application.patch.systemPromptAppend) return false;
      if (resetEnvironment && application.patch.environment) return false;
      return true;
    });
  }
}
