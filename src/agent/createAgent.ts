import type { ProviderConnectionConfig } from '../model/config.js';
import { withNodeSessionRepository } from '../node/withNodeSessionRepository.js';
import type { RuntimeContext } from '../runtime/index.js';
import { createSessionWithHost } from '../session/Session.js';
import { NODE_SESSION_HOST, SERVER_SESSION_HOST } from '../session/SessionHostProfile.js';
import type {
  HookCallback,
  ISession,
  SendOptions,
  SessionHookEvent,
  SessionOptions,
  SessionTool,
} from '../session/types.js';
import type { ToolKind } from '../tools/behavior.js';
import type { PermissionDecision } from '../types/constants.js';
import { PermissionMode } from '../types/constants.js';
import type {
  PermissionHandler,
  PermissionHandlerRequest,
  PermissionResult,
} from '../types/permissions.js';
import { AgentResponse } from './AgentResponse.js';
import type { UserMessageContent } from './UserMessageContent.js';

export type AgentProfile = 'local' | 'server';

export interface AgentFilesystemOptions {
  roots: readonly string[];
  cwd?: string;
}

export type InlineHooks = Partial<Record<SessionHookEvent, HookCallback[]>>;

export type AgentPermissionPreset = 'default' | 'accept-edits' | 'bypass-permissions' | 'plan';

export interface AgentPermissionRequest extends Omit<PermissionHandlerRequest, 'toolKind'> {
  kind: ToolKind;
}

export type AgentPermissionDecision = PermissionDecision | PermissionResult;

export type AgentPermission =
  | AgentPermissionPreset
  | ((
      request: AgentPermissionRequest,
    ) => AgentPermissionDecision | Promise<AgentPermissionDecision>);

type RootAgentOption =
  | 'provider'
  | 'model'
  | 'temperature'
  | 'maxOutputTokens'
  | 'tools'
  | 'systemPrompt'
  | 'maxTurns'
  | 'permissionMode'
  | 'permissionHandler'
  | 'canUseTool'
  | 'hooks';

export interface AgentAdvancedOptions extends Omit<SessionOptions, RootAgentOption> {
  connection?: Omit<ProviderConnectionConfig, 'type' | 'apiKey' | 'baseUrl'>;
  permission?: AgentPermission;
  /** In-process TypeScript callbacks. Shell hooks remain a CLI configuration concern. */
  hooks?: InlineHooks;
}

export interface AgentOptions {
  model: string;
  apiKey: string;
  profile?: AgentProfile;
  provider?: ProviderConnectionConfig['type'];
  baseUrl?: string;
  tools?: readonly SessionTool[];
  systemPrompt?: string;
  temperature?: number;
  maxOutputTokens?: number;
  maxTurns?: number;
  filesystem?: AgentFilesystemOptions;
  advanced?: AgentAdvancedOptions;
}

export interface Agent extends Omit<ISession, 'send' | 'stream'> {
  send(message: UserMessageContent, options?: SendOptions): Promise<AgentResponse>;
}

export async function createAgent(options: AgentOptions): Promise<Agent> {
  const {
    connection,
    permission,
    hooks,
    defaultContext,
    permissionMode: _legacyPermissionMode,
    permissionHandler: _legacyPermissionHandler,
    canUseTool: _legacyCanUseTool,
    ...advanced
  } = (options.advanced ?? {}) as AgentAdvancedOptions & {
    permissionMode?: PermissionMode;
    permissionHandler?: PermissionHandler;
    canUseTool?: unknown;
  };
  const profile = options.profile ?? (options.filesystem ? 'local' : 'server');
  const hostProfile = profile === 'local' ? NODE_SESSION_HOST : SERVER_SESSION_HOST;
  const context = mergeFilesystemContext(defaultContext, options.filesystem);

  const sessionOptions: SessionOptions = {
    ...advanced,
    provider: {
      ...connection,
      type: options.provider ?? 'openai',
      apiKey: options.apiKey,
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    },
    model: options.model,
    ...(options.tools !== undefined ? { tools: [...options.tools] } : {}),
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
    ...(context ? { defaultContext: context } : {}),
    ...(hooks ? { hooks } : {}),
    ...resolvePermission(permission),
  };

  const session = await createSessionWithHost(
    profile === 'local' ? withNodeSessionRepository(sessionOptions) : sessionOptions,
    hostProfile,
  );
  return createAgentFacade(session);
}

function createAgentFacade(session: ISession): Agent {
  let activeResponse: AgentResponse | undefined;

  const send = async (
    message: UserMessageContent,
    options?: SendOptions,
  ): Promise<AgentResponse> => {
    if (activeResponse && !activeResponse.isSettled) {
      throw new Error(
        'The previous Agent response is still active. Consume it before sending another message.',
      );
    }

    const submission = await session.send(message, options);
    if (submission.status !== 'started') {
      throw new Error(
        'High-level Agent.send() only starts new requests. Use createSession() from ' +
          '@blade-ai/agent-sdk/advanced for steering and queued inputs.',
      );
    }

    const response = new AgentResponse(submission, session.stream(), () => {
      if (activeResponse === response) {
        activeResponse = undefined;
      }
    });
    activeResponse = response;
    return response;
  };

  return new Proxy(session, {
    get(target, property) {
      if (property === 'send') {
        return send;
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as Agent;
}

function mergeFilesystemContext(
  context: RuntimeContext | undefined,
  filesystem: AgentFilesystemOptions | undefined,
): RuntimeContext | undefined {
  if (!filesystem) {
    return context;
  }

  return {
    ...(context ?? {}),
    capabilities: {
      ...(context?.capabilities ?? {}),
      filesystem: {
        roots: [...filesystem.roots],
        ...(filesystem.cwd !== undefined ? { cwd: filesystem.cwd } : {}),
      },
    },
  };
}

const PERMISSION_MODES: Record<AgentPermissionPreset, PermissionMode> = {
  default: PermissionMode.DEFAULT,
  'accept-edits': PermissionMode.AUTO_EDIT,
  'bypass-permissions': PermissionMode.YOLO,
  plan: PermissionMode.PLAN,
};

function resolvePermission(
  permission: AgentPermission | undefined,
): Pick<SessionOptions, 'permissionMode' | 'permissionHandler'> {
  if (permission === undefined) {
    return {};
  }
  if (typeof permission === 'string') {
    return {
      permissionMode: PERMISSION_MODES[permission],
    };
  }

  const permissionHandler: PermissionHandler = async (request) => {
    const { toolKind, ...rest } = request;
    const decision = await permission({
      ...rest,
      kind: toolKind,
    });
    if (typeof decision !== 'string') {
      return decision;
    }
    if (decision === 'deny') {
      return {
        behavior: 'deny',
        message: 'Denied by permission policy',
      };
    }
    return { behavior: decision };
  };

  return {
    permissionMode: PermissionMode.YOLO,
    permissionHandler,
  };
}
