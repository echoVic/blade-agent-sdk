import { nanoid } from 'nanoid';
import type { AgentPermissionRequest } from '../protocol/index.js';
import { AgentProtocolError } from '../protocol/index.js';
import type {
  ConfirmationDetails,
  ConfirmationHandler,
  ConfirmationResponse,
} from '../tools/types/execution.js';
import { PermissionRequestId, type SessionId } from '../types/identifiers.js';

interface PendingApproval {
  readonly tenantId: string;
  readonly sessionId: SessionId;
  readonly subject: string;
  readonly resolve: (response: ConfirmationResponse) => void;
  readonly reject: (error: unknown) => void;
  readonly cleanup: () => void;
}

export interface RemoteApprovalBrokerOptions {
  readonly timeoutMs?: number;
  readonly publish: (
    tenantId: string,
    sessionId: SessionId,
    request: AgentPermissionRequest,
  ) => Promise<void>;
}

export class RemoteApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly consumed = new Map<string, number>();
  private readonly timeoutMs: number;

  constructor(private readonly options: RemoteApprovalBrokerOptions) {
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new RangeError('approval timeout must be a positive safe integer');
    }
  }

  createHandler(tenantId: string, sessionId: SessionId, subject: string): ConfirmationHandler {
    return {
      requestConfirmation: (details) =>
        this.requestConfirmation(tenantId, sessionId, subject, details),
    };
  }

  resolve(
    tenantId: string,
    sessionId: SessionId,
    subject: string,
    permissionRequestId: PermissionRequestId,
    response: ConfirmationResponse,
  ): void {
    this.pruneConsumed();
    const key = this.key(tenantId, sessionId, subject, permissionRequestId);
    const pending = this.pending.get(key);
    if (!pending) {
      throw new AgentProtocolError(
        'PERMISSION_NOT_FOUND',
        `Permission request ${permissionRequestId} is not pending`,
        404,
      );
    }
    pending.cleanup();
    this.pending.delete(key);
    this.markConsumed(key);
    pending.resolve(response);
  }

  cancelSession(tenantId: string, sessionId: SessionId, reason: unknown): void {
    for (const [key, pending] of this.pending) {
      if (pending.tenantId !== tenantId || pending.sessionId !== sessionId) {
        continue;
      }
      pending.cleanup();
      this.pending.delete(key);
      this.markConsumed(key);
      pending.reject(reason);
    }
  }

  private async requestConfirmation(
    tenantId: string,
    sessionId: SessionId,
    subject: string,
    details: ConfirmationDetails,
  ): Promise<ConfirmationResponse> {
    details.abortSignal?.throwIfAborted();
    const permissionRequestId = details.permissionRequestId ?? PermissionRequestId(nanoid());
    this.pruneConsumed();
    const key = this.key(tenantId, sessionId, subject, permissionRequestId);
    if (this.pending.has(key) || this.consumed.has(key)) {
      throw new AgentProtocolError(
        'SESSION_CONFLICT',
        `Permission request ${permissionRequestId} is already pending`,
        409,
      );
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const response = new Promise<ConfirmationResponse>((resolve, reject) => {
      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
        }
        if (abortListener) {
          details.abortSignal?.removeEventListener('abort', abortListener);
        }
      };
      const pending: PendingApproval = {
        tenantId,
        sessionId,
        subject,
        resolve,
        reject,
        cleanup,
      };
      this.pending.set(key, pending);
      timeout = setTimeout(() => {
        cleanup();
        this.pending.delete(key);
        this.markConsumed(key);
        reject(
          new AgentProtocolError(
            'PERMISSION_NOT_FOUND',
            `Permission request ${permissionRequestId} timed out`,
            408,
          ),
        );
      }, this.timeoutMs);
      abortListener = () => {
        cleanup();
        this.pending.delete(key);
        this.markConsumed(key);
        reject(details.abortSignal?.reason ?? new DOMException('Request aborted', 'AbortError'));
      };
      details.abortSignal?.addEventListener('abort', abortListener, { once: true });
    });

    try {
      await this.options.publish(tenantId, sessionId, {
        permissionRequestId,
        toolName: details.toolName ?? 'unknown',
        input: details.args ?? {},
        title: details.title ?? 'Permission required',
        message: details.message,
        kind: details.kind,
        affectedPaths: details.affectedFiles ?? [],
        risks: details.risks ?? [],
      });
    } catch (error) {
      const pending = this.pending.get(key);
      pending?.cleanup();
      this.pending.delete(key);
      this.markConsumed(key);
      pending?.reject(error);
    }

    return response;
  }

  private key(
    tenantId: string,
    sessionId: SessionId,
    subject: string,
    permissionRequestId: PermissionRequestId,
  ): string {
    return JSON.stringify([tenantId, sessionId, subject, permissionRequestId]);
  }

  private pruneConsumed(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.consumed) {
      if (expiresAt <= now) {
        this.consumed.delete(key);
      }
    }
  }

  private markConsumed(key: string): void {
    this.consumed.set(key, Date.now() + this.timeoutMs);
  }
}
