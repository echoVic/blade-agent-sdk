import { describe, expect, it, vi } from 'vitest';
import {
  base64DecodedLength,
  base64PrefixToBytes,
  base64ToBytes,
  bytesToBase64,
  parseBase64DataUrl,
  toDataUrl,
} from '../base64.js';

describe('base64 helpers', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(toDataUrl('image/png', new Uint8Array([0, 127, 128, 255]))).toBe(
      'data:image/png;base64,AH+A/w==',
    );
  });

  it('returns bytes that own their whole ArrayBuffer', () => {
    const bytes = base64ToBytes('AAAA');
    expect(bytes.byteOffset).toBe(0);
    expect(bytes.buffer.byteLength).toBe(bytes.byteLength);
  });

  it('works without Buffer', () => {
    vi.stubGlobal('Buffer', undefined);
    try {
      expect(bytesToBase64(new Uint8Array([0, 127, 128, 255]))).toBe('AH+A/w==');
      expect(base64ToBytes('AH+A/w==')).toEqual(new Uint8Array([0, 127, 128, 255]));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('parses base64 data URLs and ignores everything else', () => {
    expect(parseBase64DataUrl('data:image/PNG;base64,AAAA')).toEqual({
      mediaType: 'image/png',
      base64: 'AAAA',
    });
    expect(parseBase64DataUrl('data:;base64,AAAA')).toEqual({ mediaType: '', base64: 'AAAA' });
    expect(parseBase64DataUrl('data:image/png;charset=utf-8;base64,AAAA')).toEqual({
      mediaType: 'image/png',
      base64: 'AAAA',
    });
    expect(parseBase64DataUrl('data:image/svg+xml,<svg/>')).toBeUndefined();
    expect(parseBase64DataUrl('https://example.test/a.png')).toBeUndefined();
  });

  it('computes the decoded length without decoding', () => {
    expect(base64DecodedLength('')).toBe(0);
    expect(base64DecodedLength('AAAA')).toBe(3);
    expect(base64DecodedLength('AAA=')).toBe(2);
    expect(base64DecodedLength('AA==')).toBe(1);
  });

  it('decodes only a prefix', () => {
    const bytes = new Uint8Array(1000).map((_, index) => index % 256);
    expect(base64PrefixToBytes(bytesToBase64(bytes), 10)).toEqual(bytes.subarray(0, 10));
    expect(base64PrefixToBytes(bytesToBase64(bytes), -10)).toEqual(new Uint8Array());
  });
});
