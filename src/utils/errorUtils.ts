/**
 * Not every thrown value is an Error: AbortController.abort(reason) and similar
 * control-flow signals in this codebase deliberately carry plain, structurally
 * typed objects (for example `{ kind: 'steering', inputId }`). `String(error)`
 * renders those as the useless `[object Object]`, so a non-Error, non-string
 * value falls back to its own `message` when that is a string, then a compact
 * JSON form, so a caller building a user-facing message always gets something
 * they can act on.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  // Only reach for the JSON form when the plain string conversion would be
  // the useless `[object Object]`. A class instance with a meaningful custom
  // toString() but no enumerable own properties would otherwise lose that
  // string to a bare, uninformative `{}` from JSON.stringify.
  const stringForm = String(error);
  if (stringForm === '[object Object]') {
    try {
      const json = JSON.stringify(error);
      if (json !== undefined) return json;
    } catch {
      // Circular or otherwise non-serializable value: fall through below.
    }
  }
  return stringForm;
}

export function getErrorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return 'Error';
}

export function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(getErrorMessage(error));
}

interface NodeError extends Error {
  code?: string;
  errno?: number;
  syscall?: string;
  path?: string;
}

function hasStringCode(obj: object): obj is { code: string } {
  return 'code' in obj && typeof (obj as { code?: unknown }).code === 'string';
}

function isNodeError(error: unknown): error is NodeError {
  return error instanceof Error && hasStringCode(error);
}

export function getErrorCode(error: unknown): string | undefined {
  if (isNodeError(error)) {
    return error.code;
  }
  return undefined;
}
