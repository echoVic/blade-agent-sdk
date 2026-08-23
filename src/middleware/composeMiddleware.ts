export type MiddlewareNext<TRequest, TResult> = (request?: TRequest) => TResult;

export type Middleware<TRequest, TResult> = (
  request: TRequest,
  next: MiddlewareNext<TRequest, TResult>,
) => TResult;

/**
 * Compose middleware using Koa-style onion ordering.
 *
 * The first middleware is the outermost layer. Calling next() more than once
 * from the same chain is rejected because execution is single-pass.
 */
export function composeMiddleware<TRequest, TResult>(
  middleware: readonly Middleware<TRequest, TResult>[],
  terminal: (request: TRequest) => TResult,
): (request: TRequest) => TResult {
  const stack = [...middleware];

  return (request: TRequest): TResult => {
    let index = -1;

    const dispatch = (position: number, currentRequest: TRequest): TResult => {
      if (position <= index) {
        throw new Error('next() called multiple times');
      }
      index = position;

      const current = stack[position];
      if (!current) {
        return terminal(currentRequest);
      }

      return current(
        currentRequest,
        (nextRequest = currentRequest) => dispatch(position + 1, nextRequest),
      );
    };

    return dispatch(0, request);
  };
}
