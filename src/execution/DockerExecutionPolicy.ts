import { isAbsolute, posix } from 'node:path';
import { z } from 'zod';
import type { JsonObject } from '../types/json.js';
import { jsonObjectSchema } from '../types/jsonSchema.js';
import {
  type ExecutionExecRequest,
  ExecutionHostError,
  type ExecutionProvisionRequest,
} from './ExecutionHost.js';

export const CHECKPOINT_VERSION = 1;
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_RUNTIME_MS = 24 * 60 * 60 * 1000;
const IMAGE_DIGEST = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*@sha256:[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@{}^~:+-]{0,255}$/;

const resourceLimitsSchema = z
  .object({
    cpus: z.number().positive().max(128),
    memoryBytes: z
      .number()
      .int()
      .positive()
      .max(512 * 1024 ** 3),
    diskBytes: z
      .number()
      .int()
      .positive()
      .max(1024 ** 4),
    pids: z.number().int().positive().max(32_768),
    runtimeMs: z.number().int().positive().max(MAX_RUNTIME_MS),
    maxOutputBytes: z.number().int().positive().max(MAX_OUTPUT_BYTES),
  })
  .strict();
const environmentSchema = z.record(z.string(), z.string());
export const checkpointManifestSchema = z
  .object({
    version: z.literal(CHECKPOINT_VERSION),
    image: z.string(),
    resources: resourceLimitsSchema,
    environment: environmentSchema,
    metadata: jsonObjectSchema,
  })
  .strict();
export type CheckpointManifest = z.infer<typeof checkpointManifestSchema>;

export function validateContainerUser(user: string): { uid: string; gid: string } {
  const [uid, gid] = user.split(':');
  if (
    !/^[1-9]\d*:[1-9]\d*$/.test(user) ||
    !uid ||
    !gid ||
    Number(uid) > 4_294_967_294 ||
    Number(gid) > 4_294_967_294
  ) {
    throw new ExecutionHostError(
      'EXECUTION_INVALID_REQUEST',
      'containerUser must use numeric uid:gid form with non-root identifiers',
    );
  }
  return { uid, gid };
}

export function validateProvision(
  request: ExecutionProvisionRequest,
  allowUnpinned: boolean,
): void {
  if (
    typeof request.image !== 'string' ||
    !request.image.trim() ||
    request.image.includes('\0') ||
    (!allowUnpinned && !IMAGE_DIGEST.test(request.image))
  ) {
    throw new ExecutionHostError(
      'EXECUTION_INVALID_REQUEST',
      'Execution image must use an immutable sha256 digest',
    );
  }
  const workspace = request.workspace;
  if (
    !workspace ||
    (workspace.kind !== 'empty' &&
      (workspace.kind !== 'git-worktree' ||
        !isAbsolute(workspace.repositoryPath) ||
        !REVISION_PATTERN.test(workspace.revision)))
  ) {
    throw new ExecutionHostError(
      'EXECUTION_INVALID_REQUEST',
      'Execution workspace source is invalid',
    );
  }
  if (!request.network || request.network.mode !== 'none') {
    throw new ExecutionHostError(
      'EXECUTION_NETWORK_POLICY',
      'DockerExecutionHost supports only network mode none',
    );
  }
  if (!resourceLimitsSchema.safeParse(request.resources).success) {
    throw new ExecutionHostError('EXECUTION_RESOURCE_LIMIT', 'Execution limits are invalid');
  }
  validateEnvironment(request.environment);
  validateMetadata(request.metadata ?? {}, 'Execution metadata');
}

export function validateExec(request: ExecutionExecRequest): void {
  if (
    !request.command?.trim() ||
    request.command.includes('\0') ||
    request.args?.some((value) => typeof value !== 'string' || value.includes('\0')) ||
    (request.stdin !== undefined &&
      (typeof request.stdin !== 'string' || Buffer.byteLength(request.stdin) > MAX_OUTPUT_BYTES)) ||
    (request.timeoutMs !== undefined &&
      (!Number.isSafeInteger(request.timeoutMs) ||
        request.timeoutMs < 1 ||
        request.timeoutMs > MAX_RUNTIME_MS))
  ) {
    throw new ExecutionHostError(
      'EXECUTION_INVALID_REQUEST',
      'Execution command or credentials are unsupported',
    );
  }
  workspaceCwd(request.cwd);
  validateEnvironment(request.environment);
}

export function validateEnvironment(environment: Readonly<Record<string, string>> = {}): void {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new ExecutionHostError(
      'EXECUTION_INVALID_REQUEST',
      'Execution environment must contain string values',
      { cause: parsed.error },
    );
  }
  for (const [name, value] of Object.entries(parsed.data)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      value.includes('\0') ||
      Buffer.byteLength(value) > 32 * 1024 ||
      /TOKEN|SECRET|PASSWORD|API.?KEY|CREDENTIAL/i.test(name)
    ) {
      throw new ExecutionHostError(
        'EXECUTION_INVALID_REQUEST',
        `Environment variable ${name} is invalid`,
      );
    }
  }
}

export function validateMetadata(value: unknown, label: string): JsonObject {
  const parsed = jsonObjectSchema.safeParse(value);
  if (!parsed.success) {
    throw new ExecutionHostError('EXECUTION_INVALID_REQUEST', `${label} must be a JSON object`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export function workspaceCwd(value?: string): string {
  if (value?.includes('\0')) {
    throw new ExecutionHostError(
      'EXECUTION_INVALID_REQUEST',
      'Execution cwd must stay within /workspace',
    );
  }
  const normalized = posix.normalize(value ?? '.');
  if (normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../')) {
    throw new ExecutionHostError(
      'EXECUTION_INVALID_REQUEST',
      'Execution cwd must stay within /workspace',
    );
  }
  return normalized === '.' ? '/workspace' : `/workspace/${normalized}`;
}

export function validateExecutionId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new ExecutionHostError('EXECUTION_INVALID_REQUEST', 'Execution identifier is invalid');
  }
}

export function validateCheckpointId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new ExecutionHostError(
      'EXECUTION_CHECKPOINT_INVALID',
      'Checkpoint identifier is invalid',
    );
  }
}

export function buildContainerArgs(
  request: ExecutionProvisionRequest,
  container: string,
  user: string,
  uid: string,
  gid: string,
): string[] {
  const temporaryBytes = Math.max(
    1024 * 1024,
    Math.min(16 * 1024 * 1024, Math.floor(request.resources.memoryBytes / 4)),
  );
  const args = [
    'create',
    '--name',
    container,
    '--rm',
    '--label',
    'com.blade.managed=true',
    '--init',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--cpus',
    String(request.resources.cpus),
    '--memory',
    String(request.resources.memoryBytes),
    '--memory-swap',
    String(request.resources.memoryBytes),
    '--pids-limit',
    String(request.resources.pids),
    '--network',
    'none',
    '--user',
    user,
    '--workdir',
    '/workspace',
    '--tmpfs',
    `/workspace:rw,nosuid,nodev,noexec,size=${request.resources.diskBytes},uid=${uid},gid=${gid},mode=0700`,
    '--tmpfs',
    `/tmp:rw,nosuid,nodev,noexec,size=${temporaryBytes},uid=${uid},gid=${gid},mode=0700`,
  ];
  for (const name of Object.keys(request.environment ?? {}).sort()) args.push('--env', name);
  args.push(request.image, '/bin/sh', '-c', `sleep ${request.resources.runtimeMs / 1000}`);
  return args;
}
