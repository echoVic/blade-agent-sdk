const BASE64_DATA_URL_PREFIX = /^data:([^;,]*)((?:;[^;,]*)*?);base64,/i;
const HEADER_SCAN_CHARS = 256;

export interface Base64DataUrl {
  /** Declared media type, lowercased; empty when the URL omits it. */
  readonly mediaType: string;
  readonly base64: string;
}

/** Split a base64 `data:` URL. Other URLs, including non-base64 data URLs, return undefined. */
export function parseBase64DataUrl(url: string): Base64DataUrl | undefined {
  const match = BASE64_DATA_URL_PREFIX.exec(url.slice(0, HEADER_SCAN_CHARS));
  if (!match) {
    return undefined;
  }
  return { mediaType: match[1].trim().toLowerCase(), base64: url.slice(match[0].length) };
}

/** Bytes a base64 payload decodes to, computed without decoding it. */
export function base64DecodedLength(base64: string): number {
  if (base64.length === 0) {
    return 0;
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const buffer = Buffer.from(base64, 'base64');
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Decode at most `maxBytes` from the start of a base64 payload. */
export function base64PrefixToBytes(base64: string, maxBytes: number): Uint8Array {
  return base64ToBytes(base64.slice(0, Math.ceil(maxBytes / 3) * 4));
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function toDataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${bytesToBase64(bytes)}`;
}
