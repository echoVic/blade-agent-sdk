declare const __brand: unique symbol;

export type IsEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

export type Assert<_T extends true> = never;

export type Extends<A, B> = A extends B ? true : false;

export type KeysEqual<A, B> = IsEqual<keyof A, keyof B>;
