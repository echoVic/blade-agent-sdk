/**
 * 断言值不为 null/undefined，替代非空断言操作符 (!)
 */
export function assertDefined<T>(value: T | null | undefined, msg?: string): asserts value is T {
  if (value == null) throw new Error(msg ?? 'Expected value to be defined');
}
