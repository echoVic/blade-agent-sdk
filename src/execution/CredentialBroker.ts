import { nanoid } from 'nanoid';
import type {
  CredentialLeaseId,
  ExecutionId,
} from '../types/identifiers.js';
import { CredentialLeaseId as toCredentialLeaseId } from '../types/identifiers.js';
import { ExecutionHostError } from './ExecutionHost.js';

export interface CredentialRequest {
  readonly name: string;
  readonly audience: string;
  readonly scopes?: readonly string[];
}

export interface CredentialIssueContext extends CredentialRequest {
  readonly executionId: ExecutionId;
  readonly expiresBy: string;
  readonly signal?: AbortSignal;
}

export interface IssuedCredential {
  readonly value: string;
  readonly expiresAt: string;
  readonly revoke?: () => Promise<void>;
}

export interface CredentialIssuer {
  readonly environmentVariable: string;
  issue(context: CredentialIssueContext): Promise<IssuedCredential>;
}

export interface CredentialLease {
  readonly leaseId: CredentialLeaseId;
  readonly executionId: ExecutionId;
  readonly expiresAt: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface CredentialBroker {
  acquire(
    executionId: ExecutionId,
    requests: readonly CredentialRequest[],
    ttlMs: number,
    signal?: AbortSignal,
  ): Promise<CredentialLease>;
  release(leaseId: CredentialLeaseId): Promise<void>;
}

interface ActiveCredentialLease {
  readonly publicLease: CredentialLease;
  readonly issued: readonly IssuedCredential[];
  readonly expiryTimer: ReturnType<typeof setTimeout>;
}

const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export class EphemeralCredentialBroker implements CredentialBroker {
  private readonly active = new Map<CredentialLeaseId, ActiveCredentialLease>();
  private readonly issuers: Readonly<Record<string, CredentialIssuer>>;
  private readonly maxTtlMs: number;

  constructor(
    issuers: Readonly<Record<string, CredentialIssuer>>,
    maxTtlMs = 5 * 60 * 1000,
  ) {
    if (!Number.isSafeInteger(maxTtlMs) || maxTtlMs < 1) {
      throw new ExecutionHostError(
        'EXECUTION_CREDENTIAL_ERROR',
        'Credential maxTtlMs must be a positive safe integer',
      );
    }
    const environmentVariables = new Set<string>();
    for (const [name, issuer] of Object.entries(issuers)) {
      if (!name.trim()) {
        throw new ExecutionHostError(
          'EXECUTION_CREDENTIAL_ERROR',
          'Credential issuer name must not be empty',
        );
      }
      if (!ENVIRONMENT_VARIABLE_PATTERN.test(issuer.environmentVariable)) {
        throw new ExecutionHostError(
          'EXECUTION_CREDENTIAL_ERROR',
          `Credential issuer ${name} has an invalid environment variable`,
        );
      }
      if (environmentVariables.has(issuer.environmentVariable)) {
        throw new ExecutionHostError(
          'EXECUTION_CREDENTIAL_ERROR',
          `Credential environment ${issuer.environmentVariable} is duplicated`,
        );
      }
      environmentVariables.add(issuer.environmentVariable);
    }
    this.issuers = Object.freeze({ ...issuers });
    this.maxTtlMs = maxTtlMs;
  }

  async acquire(
    executionId: ExecutionId,
    requests: readonly CredentialRequest[],
    ttlMs: number,
    signal?: AbortSignal,
  ): Promise<CredentialLease> {
    signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(ttlMs)
      || ttlMs < 1
      || ttlMs > this.maxTtlMs
    ) {
      throw new ExecutionHostError(
        'EXECUTION_CREDENTIAL_ERROR',
        `Credential ttlMs must be between 1 and ${this.maxTtlMs}`,
      );
    }
    if (requests.length === 0) {
      throw new ExecutionHostError(
        'EXECUTION_CREDENTIAL_ERROR',
        'At least one credential request is required',
      );
    }
    const expiresByMs = Date.now() + ttlMs;
    const expiresBy = new Date(expiresByMs).toISOString();
    const environment: Record<string, string> = {};
    const issued: IssuedCredential[] = [];
    try {
      for (const request of requests) {
        signal?.throwIfAborted();
        this.assertRequest(request);
        const issuer = this.issuers[request.name];
        if (!issuer) {
          throw new ExecutionHostError(
            'EXECUTION_CREDENTIAL_ERROR',
            `Credential issuer ${request.name} is not registered`,
          );
        }
        if (environment[issuer.environmentVariable] !== undefined) {
          throw new ExecutionHostError(
            'EXECUTION_CREDENTIAL_ERROR',
            `Credential environment ${issuer.environmentVariable} is duplicated`,
          );
        }
        const credential = await issuer.issue({
          ...request,
          executionId,
          expiresBy,
          ...(signal ? { signal } : {}),
        });
        signal?.throwIfAborted();
        if (
          !credential
          || typeof credential !== 'object'
          || typeof credential.value !== 'string'
          || typeof credential.expiresAt !== 'string'
        ) {
          throw new ExecutionHostError(
            'EXECUTION_CREDENTIAL_ERROR',
            `Credential issuer ${request.name} returned an invalid credential`,
          );
        }
        issued.push(credential);
        const credentialExpiry = Date.parse(credential.expiresAt);
        if (
          !credential.value
          || !Number.isFinite(credentialExpiry)
          || credentialExpiry <= Date.now()
          || credentialExpiry > expiresByMs
        ) {
          throw new ExecutionHostError(
            'EXECUTION_CREDENTIAL_ERROR',
            `Credential issuer ${request.name} returned a non-ephemeral credential`,
          );
        }
        environment[issuer.environmentVariable] = credential.value;
      }
    } catch (error) {
      await this.revokeAll(issued);
      throw error;
    }
    const leaseId = toCredentialLeaseId(`credential-${nanoid()}`);
    const leaseExpiryMs = Math.min(
      expiresByMs,
      ...issued.map((credential) => Date.parse(credential.expiresAt)),
    );
    const publicLease: CredentialLease = {
      leaseId,
      executionId,
      expiresAt: new Date(leaseExpiryMs).toISOString(),
      environment: Object.freeze({ ...environment }),
    };
    const expiryTimer = setTimeout(() => {
      void this.release(leaseId).catch(() => undefined);
    }, Math.max(1, leaseExpiryMs - Date.now()));
    expiryTimer.unref?.();
    this.active.set(leaseId, {
      publicLease,
      issued: [...issued],
      expiryTimer,
    });
    return publicLease;
  }

  async release(leaseId: CredentialLeaseId): Promise<void> {
    const lease = this.active.get(leaseId);
    if (!lease) {
      return;
    }
    this.active.delete(leaseId);
    clearTimeout(lease.expiryTimer);
    const results = await this.revokeAll(lease.issued);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') {
      throw new ExecutionHostError(
        'EXECUTION_CREDENTIAL_ERROR',
        'Credential revocation failed',
        { cause: failed.reason },
      );
    }
  }

  private revokeAll(
    issued: readonly IssuedCredential[],
  ): Promise<readonly PromiseSettledResult<void>[]> {
    return Promise.allSettled(issued.map(async (credential) => {
      if (typeof credential.revoke === 'function') {
        await credential.revoke();
      }
    }));
  }

  private assertRequest(request: CredentialRequest): void {
    if (!request.name.trim() || !request.audience.trim()) {
      throw new ExecutionHostError(
        'EXECUTION_CREDENTIAL_ERROR',
        'Credential name and audience must not be empty',
      );
    }
    if (
      request.scopes
      && (
        request.scopes.some((scope) => !scope.trim())
        || new Set(request.scopes).size !== request.scopes.length
      )
    ) {
      throw new ExecutionHostError(
        'EXECUTION_CREDENTIAL_ERROR',
        `Credential request ${request.name} has invalid scopes`,
      );
    }
  }
}
