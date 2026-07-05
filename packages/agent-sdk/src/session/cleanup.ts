import type { ISession } from './types.js';

type ClosableSession = Pick<ISession, 'close'>;

function attachCloseError(primaryError: unknown, closeError: unknown): void {
  if (!(primaryError instanceof Error)) {
    return;
  }

  const errorWithClose = primaryError as Error & { closeError?: unknown };
  if ('closeError' in errorWithClose) {
    return;
  }

  Object.defineProperty(errorWithClose, 'closeError', {
    value: closeError,
    enumerable: false,
    configurable: true,
  });
}

export async function closeSessionAfterLifecycle(
  session: ClosableSession,
  primaryError?: unknown,
): Promise<void> {
  try {
    await session.close();
  } catch (closeError) {
    if (primaryError !== undefined) {
      attachCloseError(primaryError, closeError);
      return;
    }

    throw closeError;
  }
}
