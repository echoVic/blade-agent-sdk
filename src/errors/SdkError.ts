export interface SdkErrorOptions {
  cause?: unknown;
}

export class SdkError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: SdkErrorOptions) {
    super(message, { cause: options?.cause });
    this.name = this.constructor.name;
    this.code = code;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.cause !== undefined && { cause: this.cause }),
    };
  }
}
