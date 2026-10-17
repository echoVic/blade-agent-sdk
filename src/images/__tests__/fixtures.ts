import { bytesToBase64 } from '../base64.js';

/** A real 1×1 RGBA PNG; 70 bytes once decoded. */
export const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+KDnxWQAAAABJRU5ErkJggg==';
export const ONE_PIXEL_PNG_DATA_URL = `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`;

const u16be = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const u16le = (value: number) => [value & 0xff, (value >> 8) & 0xff];
const u24le = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
const u32be = (value: number) => [
  (value >>> 24) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 8) & 0xff,
  value & 0xff,
];
const u32le = (value: number) => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  (value >>> 24) & 0xff,
];
const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

/** PNG signature and IHDR, zero-padded to `totalBytes`. Enough for sniffing and sizing only. */
export function pngBytes(width: number, height: number, totalBytes = 64): Uint8Array {
  const header = [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32be(13),
    ...ascii('IHDR'),
    ...u32be(width),
    ...u32be(height),
    8,
    6,
    0,
    0,
    0,
  ];
  const bytes = new Uint8Array(Math.max(totalBytes, header.length));
  bytes.set(header);
  return bytes;
}

export function jpegBytes(
  width: number,
  height: number,
  options: { progressive?: boolean; exifBytes?: number } = {},
): Uint8Array {
  const exif = options.exifBytes ?? 0;
  const app1 = exif > 0 ? [0xff, 0xe1, ...u16be(exif + 2), ...new Array<number>(exif).fill(0)] : [];
  const sof = [
    0xff,
    options.progressive ? 0xc2 : 0xc0,
    ...u16be(17),
    8,
    ...u16be(height),
    ...u16be(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ];
  return new Uint8Array([0xff, 0xd8, ...app1, ...sof, 0xff, 0xd9]);
}

export function gifBytes(width: number, height: number): Uint8Array {
  return new Uint8Array([...ascii('GIF89a'), ...u16le(width), ...u16le(height), 0, 0, 0]);
}

function riff(chunk: string, data: number[]): Uint8Array {
  const payload = [...ascii('WEBP'), ...ascii(chunk), ...u32le(data.length), ...data];
  return new Uint8Array([...ascii('RIFF'), ...u32le(payload.length), ...payload]);
}

export function webpLossyBytes(width: number, height: number): Uint8Array {
  return riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(width), ...u16le(height), 0, 0]);
}

export function webpLosslessBytes(width: number, height: number): Uint8Array {
  return riff('VP8L', [0x2f, ...u32le((width - 1) | ((height - 1) << 14)), 0, 0, 0, 0, 0]);
}

export function webpExtendedBytes(width: number, height: number): Uint8Array {
  return riff('VP8X', [0, 0, 0, 0, ...u24le(width - 1), ...u24le(height - 1), 0, 0]);
}

export function dataUrl(mediaType: string, bytes: Uint8Array): string {
  return `data:${mediaType};base64,${bytesToBase64(bytes)}`;
}
