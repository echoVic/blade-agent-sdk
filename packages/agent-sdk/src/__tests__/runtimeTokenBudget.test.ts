import { describe, expect, it } from 'vitest';
import { createPackageLocalRuntimeTokenBudgetOperations } from '../session/runtimeTokenBudget.js';

describe('package-local runtime token budget operations', () => {
  it('injects the session token budget into kernel creation options only when missing', () => {
    const operations = createPackageLocalRuntimeTokenBudgetOperations({
      maxTotalTokens: 100,
      warningThresholdPercent: 0.5,
    });
    const explicitBudget = createPackageLocalRuntimeTokenBudgetOperations({
      maxTotalTokens: 1,
    }).apply({}).tokenBudget;

    const injectedOptions = operations.apply({ maxSteps: 3 });
    const preservedOptions = operations.apply({
      maxSteps: 3,
      tokenBudget: explicitBudget,
    });

    expect(injectedOptions.tokenBudget).toEqual(
      expect.objectContaining({
        record: expect.any(Function),
        isWarning: expect.any(Function),
        isApproachingLimit: expect.any(Function),
        isExhausted: expect.any(Function),
        getSnapshot: expect.any(Function),
      }),
    );
    expect(preservedOptions.tokenBudget).toBe(explicitBudget);
  });

  it('leaves kernel creation options unchanged when the session has no token budget', () => {
    const operations = createPackageLocalRuntimeTokenBudgetOperations();
    const options = { maxSteps: 3 };

    expect(operations.apply(options)).toBe(options);
  });
});
