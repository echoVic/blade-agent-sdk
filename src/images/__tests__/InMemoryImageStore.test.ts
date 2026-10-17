import { describe, expect, it } from 'vitest';
import { combineImageStores, type ImageStore, sha256Hex } from '../ImageStore.js';
import { InMemoryImageStore } from '../InMemoryImageStore.js';
import { pngBytes } from './fixtures.js';

describe('InMemoryImageStore', () => {
  it('stores images by content and returns complete metadata', async () => {
    const store = new InMemoryImageStore();
    const bytes = pngBytes(1280, 720, 512);
    const ref = await store.put({ bytes, mediaType: 'image/png' });

    expect(ref).toEqual({
      url: expect.stringMatching(/^blade-image:sha256:[0-9a-f]{64}$/),
      mediaType: 'image/png',
      width: 1280,
      height: 720,
      byteLength: 512,
    });
    expect(store.handles(ref.url)).toBe(true);
    expect(await store.get(ref.url)).toEqual({ bytes, mediaType: 'image/png' });
    expect(await store.put({ bytes: bytes.slice(), mediaType: 'image/png' })).toEqual(ref);
  });

  it('copies Buffer inputs so later source mutations preserve stored bytes and their digest', async () => {
    const store = new InMemoryImageStore();
    const expected = pngBytes(2, 2, 600);
    const source = Buffer.from(expected);
    const ref = await store.put({ bytes: source, mediaType: 'image/png' });

    source.fill(0);
    const stored = await store.get(ref.url);
    if (!stored || !('bytes' in stored)) throw new Error('Expected stored image bytes');

    expect(new Uint8Array(stored.bytes)).toEqual(expected);
    expect(ref.url).toBe(`blade-image:sha256:${await sha256Hex(stored.bytes)}`);
  });

  it('copies a Buffer subarray into an ArrayBuffer sized to the stored bytes', async () => {
    const store = new InMemoryImageStore({ maxBytes: 1_000 });
    const parent = Buffer.alloc(8 * 1024 * 1024);
    parent.set(pngBytes(2, 2, 600));
    const source = parent.subarray(0, 600);
    const ref = await store.put({ bytes: source, mediaType: 'image/png' });
    const stored = await store.get(ref.url);
    if (!stored || !('bytes' in stored)) throw new Error('Expected stored image bytes');

    expect(stored.bytes.byteLength).toBe(600);
    expect(stored.bytes.buffer.byteLength).toBe(stored.bytes.byteLength);
    expect(stored.bytes.buffer).not.toBe(parent.buffer);
  });

  it('isolates tenants', async () => {
    const store = new InMemoryImageStore();
    const ref = await store
      .forTenant('tenant-a')
      .put({ bytes: pngBytes(2, 2), mediaType: 'image/png' });

    expect(await store.forTenant('tenant-a').get(ref.url)).toBeDefined();
    expect(await store.forTenant('tenant-b').get(ref.url)).toBeUndefined();
    expect(await store.get(ref.url)).toBeUndefined();
  });

  it('evicts the least recently used images past maxBytes', async () => {
    const store = new InMemoryImageStore({ maxBytes: 1_000 });
    const first = await store.put({ bytes: pngBytes(1, 1, 400), mediaType: 'image/png' });
    const second = await store.put({ bytes: pngBytes(2, 2, 400), mediaType: 'image/png' });
    await store.get(first.url);
    await store.put({ bytes: pngBytes(3, 3, 400), mediaType: 'image/png' });

    expect(await store.get(first.url)).toBeDefined();
    expect(await store.get(second.url)).toBeUndefined();
  });

  it('refuses non-raster bytes and images larger than the store', async () => {
    const store = new InMemoryImageStore({ maxBytes: 100 });
    await expect(
      store.put({ bytes: new TextEncoder().encode('<svg/>'), mediaType: 'image/svg+xml' }),
    ).rejects.toThrow(TypeError);
    await expect(store.put({ bytes: pngBytes(1, 1, 200), mediaType: 'image/png' })).rejects.toThrow(
      RangeError,
    );
    expect(() => new InMemoryImageStore({ maxBytes: 0 })).toThrow(RangeError);
  });

  it('ignores references it does not own', async () => {
    const store = new InMemoryImageStore();
    expect(store.handles('lark-image:img_v3')).toBe(false);
    expect(store.handles('blade-image:sha256:abc')).toBe(false);
    expect(await store.get('https://example.test/a.png')).toBeUndefined();
  });
  it('snapshots bytes before awaiting the digest', async () => {
    const store = new InMemoryImageStore();
    const original = pngBytes(2, 2, 600);
    const source = original.slice();
    const pending = store.put({ bytes: source, mediaType: 'image/png' });
    source.fill(0);
    const ref = await pending;
    const stored = await store.get(ref.url);
    if (!stored || !('bytes' in stored)) throw new Error('Expected stored bytes');
    expect(stored.bytes).toEqual(original);
    expect(ref.url).toBe(`blade-image:sha256:${await sha256Hex(stored.bytes)}`);
  });

  it('returns independent byte arrays on every read', async () => {
    const store = new InMemoryImageStore();
    const bytes = pngBytes(2, 3);
    const ref = await store.put({ bytes, mediaType: 'image/png' });
    const first = await store.get(ref.url);
    if (!first || !('bytes' in first)) throw new Error('Expected stored bytes');
    first.bytes.fill(0);
    expect(await store.get(ref.url)).toEqual({ bytes, mediaType: 'image/png' });
  });
});

describe('combineImageStores', () => {
  it('writes to the primary store and reads from whichever store owns the reference', async () => {
    const primary = new InMemoryImageStore();
    const lark: ImageStore = {
      handles: (url) => url.startsWith('lark-image:'),
      put: async () => {
        throw new Error('read-only');
      },
      get: async (url) =>
        url === 'lark-image:img_1' ? { url: 'https://cdn.example.test/img_1.png' } : undefined,
    };
    const store = combineImageStores(primary, lark);
    const ref = await store.put({ bytes: pngBytes(4, 4), mediaType: 'image/png' });

    expect(await store.get(ref.url)).toMatchObject({ mediaType: 'image/png' });
    expect(store.handles('lark-image:img_1')).toBe(true);
    expect(await store.get('lark-image:img_1')).toEqual({
      url: 'https://cdn.example.test/img_1.png',
    });
    expect(store.handles('s3://bucket/key')).toBe(false);
    expect(await store.get('s3://bucket/key')).toBeUndefined();
    await store.delete?.(ref.url);
    expect(await store.get(ref.url)).toBeUndefined();
  });

  it('hashes with SHA-256', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
