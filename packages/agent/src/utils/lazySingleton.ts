/**
 * Lazy singleton factory — defers construction until the first call and
 * reuses the same instance thereafter.  No Node dependencies.
 */
export function lazySingleton<T>(factory: () => T): () => T {
  let instance: T | undefined;
  return () => {
    if (instance === undefined) {
      instance = factory();
    }
    return instance;
  };
}
