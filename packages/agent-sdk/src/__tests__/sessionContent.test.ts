import { describe, expect, it } from 'vitest';
import {
  countUserMessageImages,
  getUserMessageText,
  parseJsonOrString,
} from '../session/content.js';

describe('agent-sdk session content helpers', () => {
  it('extracts text from string and multimodal user messages', () => {
    expect(getUserMessageText('hello blade')).toBe('hello blade');

    expect(
      getUserMessageText([
        { type: 'text', text: 'first' },
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        { type: 'text', text: 'second' },
      ]),
    ).toBe('first\nsecond');
  });

  it('counts image parts without treating plain text as images', () => {
    expect(countUserMessageImages('plain text')).toBe(0);
    expect(
      countUserMessageImages([
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        { type: 'text', text: 'caption' },
        { type: 'image_url', image_url: { url: 'https://example.com/b.png' } },
      ]),
    ).toBe(2);
  });

  it('parses JSON tool arguments and falls back to the original string', () => {
    expect(parseJsonOrString('{"ok":true,"count":2}')).toEqual({ ok: true, count: 2 });
    expect(parseJsonOrString('not json')).toBe('not json');
  });
});
