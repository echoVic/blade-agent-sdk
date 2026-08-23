import { describe, expect, it } from 'vitest';
import {
  composeMiddleware,
  type Middleware,
} from '../composeMiddleware.js';

describe('composeMiddleware', () => {
  it('runs the first middleware as the outermost onion layer', async () => {
    const calls: string[] = [];
    const middleware: Middleware<number, Promise<number>>[] = [
      async (request, next) => {
        calls.push('first:before');
        const result = await next(request + 1);
        calls.push('first:after');
        return result + 1;
      },
      async (request, next) => {
        calls.push('second:before');
        const result = await next(request * 2);
        calls.push('second:after');
        return result * 2;
      },
    ];

    const execute = composeMiddleware(
      middleware,
      async (request) => {
        calls.push(`terminal:${request}`);
        return request;
      },
    );

    await expect(execute(2)).resolves.toBe(13);
    expect(calls).toEqual([
      'first:before',
      'second:before',
      'terminal:6',
      'second:after',
      'first:after',
    ]);
  });

  it('rejects multiple next calls in one execution chain', async () => {
    const execute = composeMiddleware<number, Promise<number>>(
      [
        async (request, next) => {
          await next(request);
          return next(request);
        },
      ],
      async (request) => request,
    );

    await expect(execute(1)).rejects.toThrow('next() called multiple times');
  });

  it('can short-circuit without invoking the terminal', async () => {
    const execute = composeMiddleware<number, Promise<number>>(
      [async () => 42],
      async () => {
        throw new Error('terminal should not run');
      },
    );

    await expect(execute(1)).resolves.toBe(42);
  });
});
