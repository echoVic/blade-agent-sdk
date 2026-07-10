import { describe, expect, it } from 'vitest';
import {
  AbortError,
  ConfigError,
  PermissionDeniedError,
  SdkError,
  ToolExecutionError,
} from '../errors/index.js';
import type { SdkErrorOptions } from '../errors/index.js';
import * as browserEntry from '../browser/index.js';
import * as coreEntry from '../core/index.js';
import * as rootEntry from '../index.js';
import * as serverEntry from '../server/index.js';

describe('agent-sdk errors entry', () => {
  it('exposes a package-local SDK error hierarchy', () => {
    const cause = new Error('inner');
    const options: SdkErrorOptions = { cause };
    const base = new SdkError('CUSTOM', 'Custom failure', options);
    const abort = new AbortError();
    const config = new ConfigError('Bad config');
    const permission = new PermissionDeniedError('Denied');
    const tool = new ToolExecutionError('Read', 'Missing file');

    expect(base).toBeInstanceOf(Error);
    expect(base.code).toBe('CUSTOM');
    expect(base.cause).toBe(cause);
    expect(abort.code).toBe('ABORT');
    expect(config.code).toBe('CONFIG_ERROR');
    expect(permission.code).toBe('PERMISSION_DENIED');
    expect(tool.code).toBe('TOOL_EXECUTION_ERROR');
    expect(tool.toolName).toBe('Read');
    expect(tool.message).toBe('[Read] Missing file');
    expect(tool.toJSON()).toMatchObject({
      name: 'ToolExecutionError',
      code: 'TOOL_EXECUTION_ERROR',
      message: '[Read] Missing file',
      toolName: 'Read',
    });
  });

  it('keeps public facades aligned on browser-safe error exports', () => {
    for (const entry of [rootEntry, serverEntry, coreEntry, browserEntry]) {
      expect(entry.SdkError).toBe(SdkError);
      expect(entry.AbortError).toBe(AbortError);
      expect(entry.ConfigError).toBe(ConfigError);
      expect(entry.PermissionDeniedError).toBe(PermissionDeniedError);
      expect(entry.ToolExecutionError).toBe(ToolExecutionError);
    }
  });
});
