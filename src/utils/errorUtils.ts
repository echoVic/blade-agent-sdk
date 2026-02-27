export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

export function getErrorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return 'Error';
}

export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(getErrorMessage(error));
}

export interface NodeError extends Error {
  code?: string;
  errno?: number;
  syscall?: string;
  path?: string;
}

function hasStringCode(obj: object): obj is { code: string } {
  return 'code' in obj && typeof (obj as { code?: unknown }).code === 'string';
}

export function isNodeError(error: unknown): error is NodeError {
  return error instanceof Error && hasStringCode(error);
}

export function getErrorCode(error: unknown): string | undefined {
  if (isNodeError(error)) {
    return error.code;
  }
  return undefined;
}
