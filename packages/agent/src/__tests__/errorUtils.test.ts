import { describe, expect, it } from 'vitest';
import {
  getErrorCode,
  getErrorMessage,
  getErrorName,
  toError,
} from '../utils/errorUtils.js';

describe('package-local errorUtils', () => {
  describe('getErrorMessage', () => {
    it('returns the message from an Error object', () => {
      expect(getErrorMessage(new Error('test error'))).toBe('test error');
    });

    it('returns the string itself for string input', () => {
      expect(getErrorMessage('something went wrong')).toBe('something went wrong');
    });

    it('converts non-string, non-Error input via String()', () => {
      expect(getErrorMessage(42)).toBe('42');
      expect(getErrorMessage(null)).toBe('null');
      expect(getErrorMessage(undefined)).toBe('undefined');
    });

    it('handles custom error subclasses', () => {
      class CustomError extends Error {
        constructor(msg: string) {
          super(msg);
          this.name = 'CustomError';
        }
      }
      expect(getErrorMessage(new CustomError('custom msg'))).toBe('custom msg');
    });
  });

  describe('getErrorName', () => {
    it('returns error.name for Error objects', () => {
      expect(getErrorName(new Error('msg'))).toBe('Error');
    });

    it('returns the constructor name for custom errors', () => {
      class ValidationError extends Error {
        constructor(msg: string) {
          super(msg);
          this.name = 'ValidationError';
        }
      }
      expect(getErrorName(new ValidationError('invalid'))).toBe('ValidationError');
    });

    it('returns "Error" for non-Error input', () => {
      expect(getErrorName('not an error')).toBe('Error');
      expect(getErrorName(42)).toBe('Error');
    });
  });

  describe('toError', () => {
    it('returns Error objects unchanged', () => {
      const err = new Error('original');
      expect(toError(err)).toBe(err);
    });

    it('wraps a string into an Error', () => {
      const result = toError('something failed');
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('something failed');
    });

    it('wraps a number into an Error', () => {
      const result = toError(42);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('42');
    });
  });

  describe('getErrorCode', () => {
    it('returns undefined for errors without a string code', () => {
      expect(getErrorCode(new Error('msg'))).toBeUndefined();
    });

    it('returns the code property for node-style errors', () => {
      const nodeErr = Object.assign(new Error('file not found'), { code: 'ENOENT' });
      expect(getErrorCode(nodeErr)).toBe('ENOENT');
    });

    it('returns undefined when code is present but not a string', () => {
      const err = Object.assign(new Error('msg'), { code: 42 });
      expect(getErrorCode(err)).toBeUndefined();
    });
  });
});
