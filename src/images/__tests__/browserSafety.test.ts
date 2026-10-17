import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('images module', () => {
  it('stays browser-safe', () => {
    for (const file of readdirSync('src/images').filter((name) => name.endsWith('.ts'))) {
      expect(readFileSync(join('src/images', file), 'utf8'), file).not.toMatch(/node:/);
    }
  });
});
