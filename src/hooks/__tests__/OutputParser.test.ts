import { describe, expect, it } from 'bun:test';
import { OutputParser } from '../OutputParser.js';
import type { CommandHook, HookConfig, ProcessResult } from '../types/HookTypes.js';
import { HookType } from '../types/HookTypes.js';

describe('OutputParser', () => {
  const parser = new OutputParser();

  const mockHook: CommandHook = {
    type: HookType.Command,
    command: 'echo test',
  };

  describe('exit code handling', () => {
    it('should return success for exit code 0', () => {
      const result: ProcessResult = {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };

      const parsed = parser.parse(result, mockHook);
      expect(parsed.success).toBe(true);
      expect(parsed.blocking).toBeUndefined();
    });

    it('should return blocking error for exit code 2', () => {
      const result: ProcessResult = {
        stdout: '',
        stderr: 'Blocked by hook',
        exitCode: 2,
        timedOut: false,
      };

      const parsed = parser.parse(result, mockHook);
      expect(parsed.success).toBe(false);
      expect(parsed.blocking).toBe(true);
      expect(parsed.error).toBe('Blocked by hook');
    });

    it('should return non-blocking error for other exit codes with ignore behavior', () => {
      const result: ProcessResult = {
        stdout: '',
        stderr: 'Some error',
        exitCode: 1,
        timedOut: false,
      };

      const parsed = parser.parse(result, mockHook, { failureBehavior: 'ignore' });
      expect(parsed.success).toBe(false);
      expect(parsed.blocking).toBe(false);
      expect(parsed.warning).toBe('Some error');
    });

    it('should return blocking error for other exit codes with deny behavior', () => {
      const result: ProcessResult = {
        stdout: '',
        stderr: 'Some error',
        exitCode: 1,
        timedOut: false,
      };

      const config: Pick<HookConfig, 'failureBehavior'> = { failureBehavior: 'deny' };
      const parsed = parser.parse(result, mockHook, config);
      expect(parsed.success).toBe(false);
      expect(parsed.blocking).toBe(true);
      expect(parsed.error).toBe('Some error');
    });

    it('should request confirmation for other exit codes with ask behavior', () => {
      const result: ProcessResult = {
        stdout: '',
        stderr: 'Some error',
        exitCode: 1,
        timedOut: false,
      };

      const config: Pick<HookConfig, 'failureBehavior'> = { failureBehavior: 'ask' };
      const parsed = parser.parse(result, mockHook, config);
      expect(parsed.success).toBe(false);
      expect(parsed.blocking).toBe(false);
      expect(parsed.needsConfirmation).toBe(true);
    });
  });

  describe('timeout handling', () => {
    it('should handle timeout with ignore behavior', () => {
      const result: ProcessResult = {
        stdout: '',
        stderr: '',
        exitCode: 124,
        timedOut: true,
      };

      const parsed = parser.parse(result, mockHook, { timeoutBehavior: 'ignore' });
      expect(parsed.success).toBe(false);
      expect(parsed.blocking).toBe(false);
      expect(parsed.warning).toBe('Hook timeout');
    });

    it('should handle timeout with deny behavior', () => {
      const result: ProcessResult = {
        stdout: '',
        stderr: '',
        exitCode: 124,
        timedOut: true,
      };

      const parsed = parser.parse(result, mockHook, { timeoutBehavior: 'deny' });
      expect(parsed.success).toBe(false);
      expect(parsed.blocking).toBe(true);
      expect(parsed.error).toBe('Hook timeout');
    });

    it('should handle timeout with ask behavior', () => {
      const result: ProcessResult = {
        stdout: '',
        stderr: '',
        exitCode: 124,
        timedOut: true,
      };

      const parsed = parser.parse(result, mockHook, { timeoutBehavior: 'ask' });
      expect(parsed.success).toBe(false);
      expect(parsed.blocking).toBe(false);
      expect(parsed.needsConfirmation).toBe(true);
    });
  });

  describe('JSON output parsing', () => {
    it('should parse valid JSON output with approve decision', () => {
      const result: ProcessResult = {
        stdout: JSON.stringify({
          decision: { behavior: 'approve' },
        }),
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };

      const parsed = parser.parse(result, mockHook);
      expect(parsed.success).toBe(true);
      expect(parsed.output).toBeDefined();
    });

    it('should parse JSON output with block decision', () => {
      const result: ProcessResult = {
        stdout: JSON.stringify({
          decision: { behavior: 'block' },
          systemMessage: 'Operation blocked',
        }),
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };

      const parsed = parser.parse(result, mockHook);
      expect(parsed.success).toBe(false);
      expect(parsed.blocking).toBe(true);
      expect(parsed.error).toBe('Operation blocked');
    });

    it('should parse JSON output with async decision', () => {
      const result: ProcessResult = {
        stdout: JSON.stringify({
          decision: { behavior: 'async' },
        }),
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };

      const parsed = parser.parse(result, mockHook);
      expect(parsed.success).toBe(true);
    });

    it('should parse JSON with hookSpecificOutput', () => {
      const result: ProcessResult = {
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'Not allowed',
          },
        }),
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };

      const parsed = parser.parse(result, mockHook);
      expect(parsed.success).toBe(true);
      expect(parsed.output?.hookSpecificOutput).toBeDefined();
    });

    it('should handle invalid JSON gracefully', () => {
      const result: ProcessResult = {
        stdout: 'not valid json',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };

      const parsed = parser.parse(result, mockHook);
      expect(parsed.success).toBe(true);
    });

    it('should handle empty stdout', () => {
      const result: ProcessResult = {
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };

      const parsed = parser.parse(result, mockHook);
      expect(parsed.success).toBe(true);
    });

    it('should handle JSON with extra whitespace', () => {
      const result: ProcessResult = {
        stdout: `
          {
            "decision": { "behavior": "approve" }
          }
        `,
        stderr: '',
        exitCode: 0,
        timedOut: false,
      };

      const parsed = parser.parse(result, mockHook);
      expect(parsed.success).toBe(true);
    });
  });

  describe('error message extraction', () => {
    it('should use stderr as error message when available', () => {
      const result: ProcessResult = {
        stdout: 'stdout content',
        stderr: 'stderr error',
        exitCode: 2,
        timedOut: false,
      };

      const parsed = parser.parse(result, mockHook);
      expect(parsed.error).toBe('stderr error');
    });

    it('should use stdout as error message when stderr is empty', () => {
      const result: ProcessResult = {
        stdout: 'stdout error',
        stderr: '',
        exitCode: 2,
        timedOut: false,
      };

      const parsed = parser.parse(result, mockHook);
      expect(parsed.error).toBe('stdout error');
    });

    it('should use default message when both are empty', () => {
      const result: ProcessResult = {
        stdout: '',
        stderr: '',
        exitCode: 2,
        timedOut: false,
      };

      const parsed = parser.parse(result, mockHook);
      expect(parsed.error).toBe('Hook returned exit code 2');
    });
  });
});
