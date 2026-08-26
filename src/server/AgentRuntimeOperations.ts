import type { AgentWorkerHealth } from './AgentWorker.js';
import { SdkError } from '../errors/SdkError.js';
import type { JsonObject } from '../types/json.js';
import type { RuntimeEffectRecord, RuntimeStore } from './RuntimeStore.js';
import type { RuntimeEffectReconciliation, RuntimeQueueMetrics } from './WorkerRuntime.js';

const DEFAULT_BASE_PATH = '/v1/runtime';
const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_EFFECT_LIMIT = 100;

export type RuntimeOperationsAction = 'metrics.read' | 'effects.read' | 'effects.reconcile';
export type RuntimeOperationsErrorCode = 'RUNTIME_OPERATIONS_UNSUPPORTED';

export class RuntimeOperationsError extends SdkError {
  // biome-ignore lint/complexity/noUselessConstructor: narrows the public error-code contract
  constructor(code: RuntimeOperationsErrorCode, message: string) {
    super(code, message);
  }
}

export interface RuntimeOperationsPrincipal {
  readonly tenantId: string;
  readonly subject: string;
}

export interface RuntimeOperationsWorker {
  getHealth(): AgentWorkerHealth;
}

export interface AgentRuntimeOperationsOptions {
  readonly store: RuntimeStore;
  readonly authorize: (
    request: Request,
    action: RuntimeOperationsAction,
  ) => RuntimeOperationsPrincipal | null | Promise<RuntimeOperationsPrincipal | null>;
  readonly workers?:
    | readonly RuntimeOperationsWorker[]
    | (() => readonly RuntimeOperationsWorker[]);
  readonly basePath?: string;
  readonly maxRequestBytes?: number;
}

export interface RuntimeOperationsHealth {
  readonly status: 'ready' | 'not_ready' | 'failed';
  readonly live: boolean;
  readonly ready: boolean;
  readonly checkedAt: string;
  readonly store: {
    readonly ready: boolean;
    readonly details?: JsonObject;
  };
  readonly workers: readonly AgentWorkerHealth[];
}

export interface RuntimeEffectOperationRecord {
  readonly tenantId: string;
  readonly sessionId: RuntimeEffectRecord['sessionId'];
  readonly commandId: RuntimeEffectRecord['commandId'];
  readonly effectId: string;
  readonly type: string;
  readonly status: RuntimeEffectRecord['status'];
  readonly attempts: number;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly error?: RuntimeEffectRecord['error'];
}

export interface RuntimeUncertainEffect extends RuntimeEffectOperationRecord {
  readonly status: 'uncertain';
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function summarizeEffect(effect: RuntimeEffectRecord): RuntimeEffectOperationRecord {
  return {
    tenantId: effect.tenantId,
    sessionId: effect.sessionId,
    commandId: effect.commandId,
    effectId: effect.effectId,
    type: effect.type,
    status: effect.status,
    attempts: effect.attempts,
    createdAt: effect.createdAt,
    ...(effect.completedAt ? { completedAt: effect.completedAt } : {}),
    ...(effect.error ? { error: structuredClone(effect.error) } : {}),
  };
}

function statusForError(error: unknown): number {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  switch (code) {
    case 'EFFECT_NOT_FOUND':
      return 404;
    case 'EFFECT_RETRY_NOT_ALLOWED':
      return 409;
    case 'WORKER_INVALID':
      return 400;
    case 'RUNTIME_OPERATIONS_UNSUPPORTED':
      return 501;
    default:
      return error instanceof RangeError ||
        error instanceof TypeError ||
        error instanceof SyntaxError ||
        error instanceof URIError
        ? 400
        : 500;
  }
}

function errorMessage(error: unknown, status: number): string {
  if (status >= 500) {
    return 'Runtime operations request failed';
  }
  return error instanceof Error ? error.message : String(error);
}

export class AgentRuntimeOperations {
  private readonly basePath: string;
  private readonly maxRequestBytes: number;

  constructor(private readonly options: AgentRuntimeOperationsOptions) {
    this.basePath = `/${(options.basePath ?? DEFAULT_BASE_PATH).replace(/^\/+|\/+$/g, '')}`;
    this.maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    if (!Number.isSafeInteger(this.maxRequestBytes) || this.maxRequestBytes < 1) {
      throw new RangeError('maxRequestBytes must be a positive safe integer');
    }
  }

  async healthCheck(): Promise<RuntimeOperationsHealth> {
    let storeHealth: Awaited<ReturnType<RuntimeStore['healthCheck']>>;
    try {
      storeHealth = await this.options.store.healthCheck();
    } catch {
      storeHealth = {
        ready: false,
        details: { error: 'runtime_store_unavailable' },
      };
    }
    const workers = this.resolveWorkers().map((worker) => worker.getHealth());
    const live = workers.length === 0 || workers.some((worker) => worker.live);
    const workerReady = workers.length === 0 || workers.some((worker) => worker.ready);
    const ready = storeHealth.ready && workerReady;
    return {
      status: !live ? 'failed' : ready ? 'ready' : 'not_ready',
      live,
      ready,
      checkedAt: new Date().toISOString(),
      store: {
        ready: storeHealth.ready,
        ...(storeHealth.details ? { details: structuredClone(storeHealth.details) } : {}),
      },
      workers,
    };
  }

  getQueueMetrics(tenantId: string): Promise<RuntimeQueueMetrics> {
    this.assertTenantId(tenantId);
    if (!this.options.store.getQueueMetrics) {
      throw new RuntimeOperationsError(
        'RUNTIME_OPERATIONS_UNSUPPORTED',
        'Runtime Store does not provide queue metrics',
      );
    }
    return this.options.store.getQueueMetrics(tenantId);
  }

  async listUncertainEffects(
    tenantId: string,
    limit = DEFAULT_EFFECT_LIMIT,
  ): Promise<readonly RuntimeUncertainEffect[]> {
    this.assertTenantId(tenantId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError('Effect list limit must be between 1 and 1000');
    }
    const effects = await this.options.store.listEffects(tenantId, {
      status: 'uncertain',
      limit,
    });
    return effects.map((effect) => {
      if (effect.status !== 'uncertain') {
        throw new TypeError(`Effect ${effect.effectId} is not uncertain`);
      }
      return summarizeEffect(effect) as RuntimeUncertainEffect;
    });
  }

  async reconcileUncertainEffect(
    tenantId: string,
    effectId: string,
    outcome: RuntimeEffectReconciliation,
  ): Promise<RuntimeEffectRecord> {
    this.assertTenantId(tenantId);
    if (!effectId.trim()) {
      throw new TypeError('effectId must not be empty');
    }
    return this.options.store.reconcileEffect(tenantId, effectId, outcome);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === 'GET' &&
      (url.pathname === `${this.basePath}/healthz` || url.pathname === `${this.basePath}/readyz`)
    ) {
      let health: RuntimeOperationsHealth;
      try {
        health = await this.healthCheck();
      } catch {
        return json(
          {
            status: 'failed',
            live: false,
            ready: false,
            checkedAt: new Date().toISOString(),
            store: { ready: false },
            workers: {
              total: 0,
              live: 0,
              ready: 0,
              failed: 0,
            },
          },
          503,
        );
      }
      const live = url.pathname.endsWith('/healthz');
      return json(
        {
          status: health.status,
          live: health.live,
          ready: health.ready,
          checkedAt: health.checkedAt,
          store: { ready: health.store.ready },
          workers: {
            total: health.workers.length,
            live: health.workers.filter((worker) => worker.live).length,
            ready: health.workers.filter((worker) => worker.ready).length,
            failed: health.workers.filter((worker) => worker.status === 'failed').length,
          },
        },
        live ? (health.live ? 200 : 503) : health.ready ? 200 : 503,
      );
    }

    let action: RuntimeOperationsAction;
    if (request.method === 'GET' && url.pathname === `${this.basePath}/metrics`) {
      action = 'metrics.read';
    } else if (request.method === 'GET' && url.pathname === `${this.basePath}/effects/uncertain`) {
      action = 'effects.read';
    } else if (
      request.method === 'POST' &&
      new RegExp(`^${this.escapeRegExp(this.basePath)}/effects/[^/]+/reconcile$`).test(url.pathname)
    ) {
      action = 'effects.reconcile';
    } else {
      return json({ error: 'Route not found' }, 404);
    }

    let principal: RuntimeOperationsPrincipal | null;
    try {
      principal = await this.options.authorize(request, action);
    } catch {
      return json({ error: 'Runtime operations authorization failed' }, 500);
    }
    if (!principal) {
      return json({ error: 'Authentication required' }, 401);
    }
    try {
      this.assertTenantId(principal.tenantId);
      if (action === 'metrics.read') {
        return json({
          queue: await this.getQueueMetrics(principal.tenantId),
        });
      }
      if (action === 'effects.read') {
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit === null ? DEFAULT_EFFECT_LIMIT : Number(rawLimit);
        return json({
          effects: await this.listUncertainEffects(principal.tenantId, limit),
        });
      }

      const match = new RegExp(
        `^${this.escapeRegExp(this.basePath)}/effects/([^/]+)/reconcile$`,
      ).exec(url.pathname);
      const effectId = match?.[1] ? decodeURIComponent(match[1]) : '';
      const outcome = await this.parseReconciliation(request);
      const effect = await this.reconcileUncertainEffect(principal.tenantId, effectId, outcome);
      return json({ effect: summarizeEffect(effect) });
    } catch (error) {
      const status = statusForError(error);
      return json({ error: errorMessage(error, status) }, status);
    }
  }

  private async parseReconciliation(request: Request): Promise<RuntimeEffectReconciliation> {
    const contentLength = Number(request.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > this.maxRequestBytes) {
      throw new RangeError('Reconciliation body is too large');
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > this.maxRequestBytes) {
      throw new RangeError('Reconciliation body is too large');
    }
    const value = JSON.parse(text) as unknown;
    if (!isJsonObject(value)) {
      throw new TypeError('Reconciliation body must be a JSON object');
    }
    if (value.status === 'completed') {
      if (value.result !== undefined && !isJsonObject(value.result)) {
        throw new TypeError('Completed reconciliation result must be a JSON object');
      }
      return {
        status: 'completed',
        ...(value.result ? { result: value.result } : {}),
      };
    }
    if (value.status === 'failed' && isJsonObject(value.error)) {
      return {
        status: 'failed',
        error: value.error,
      };
    }
    throw new TypeError('Reconciliation requires completed/result or failed/error');
  }

  private resolveWorkers(): readonly RuntimeOperationsWorker[] {
    const workers = this.options.workers;
    return typeof workers === 'function' ? workers() : (workers ?? []);
  }

  private assertTenantId(tenantId: string): void {
    if (!tenantId.trim()) {
      throw new TypeError('tenantId must not be empty');
    }
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
