import type Type from 'typebox';
import Schema from 'typebox/schema';
import Value from 'typebox/value';
import { SdkError } from '../../errors/SdkError.js';
import { ToolErrorType } from '../types/result.js';

interface ToolInputIssue {
  field: string;
  message: string;
  value?: unknown;
}

class ToolInputValidationError extends SdkError {
  constructor(
    message: string,
    public readonly issues: readonly ToolInputIssue[],
    public readonly type: ToolErrorType = ToolErrorType.VALIDATION_ERROR,
  ) {
    super('TOOL_VALIDATION_ERROR', message);
    this.name = 'ToolValidationError';
  }

  override toJSON(): Record<string, unknown> {
    return {
      ...super.toJSON(),
      issues: this.issues,
      type: this.type,
    };
  }
}

export interface CompiledToolInput<TSchema extends Type.TSchema> {
  readonly schema: TSchema;
  parse(value: unknown): Type.Static<TSchema>;
}

const compiledInputs = new WeakMap<object, CompiledToolInput<Type.TSchema>>();

export function compileToolInput<TSchema extends Type.TSchema>(
  schema: TSchema,
): CompiledToolInput<TSchema> {
  const cached = compiledInputs.get(schema);
  if (cached) {
    return cached as CompiledToolInput<TSchema>;
  }

  const validator = Schema.Compile(schema);
  const compiled: CompiledToolInput<TSchema> = {
    schema,
    parse(value) {
      const withDefaults = Value.Default(schema, Value.Clone(value));
      const [valid, errors] = validator.Errors(withDefaults);
      if (!valid) {
        throw formatValidationError(errors, withDefaults);
      }
      return validator.Parse(withDefaults) as Type.Static<TSchema>;
    },
  };
  compiledInputs.set(schema, compiled as CompiledToolInput<Type.TSchema>);
  return compiled;
}

function formatValidationError(
  errors: ReadonlyArray<{
    instancePath: string;
    message: string;
  }>,
  value: unknown,
): ToolInputValidationError {
  const issues = errors.map((error) => {
    const field = formatInstancePath(error.instancePath);
    return {
      field,
      message: error.message,
      value: getValueAtPath(value, error.instancePath),
    };
  });
  const message =
    issues.length === 1
      ? `参数验证失败 [${issues[0].field}]: ${issues[0].message}`
      : `参数验证失败 (${issues.length} 个错误):\n${issues
          .map((issue) => `  - ${issue.field}: ${issue.message}`)
          .join('\n')}`;

  return new ToolInputValidationError(message, issues);
}

function formatInstancePath(instancePath: string): string {
  if (!instancePath) {
    return 'root';
  }
  return instancePath.slice(1).split('/').map(decodeJsonPointerSegment).join('.');
}

function getValueAtPath(value: unknown, instancePath: string): unknown {
  if (!instancePath) {
    return value;
  }

  let current = value;
  for (const segment of instancePath.slice(1).split('/').map(decodeJsonPointerSegment)) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}
