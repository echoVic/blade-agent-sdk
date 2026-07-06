import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('session-first GLM live smoke script', () => {
  it('declares a dedicated session-first live GLM smoke command', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const scriptPath = 'scripts/test-live-session-glm.mjs';

    expect(packageJson.scripts['test:live:session-glm']).toBe(
      'pnpm --filter @blade-ai/ai run build && pnpm --filter @blade-ai/agent run build && pnpm --filter @blade-ai/agent-sdk run build && node scripts/test-live-session-glm.mjs',
    );
    expect(existsSync(scriptPath), `${scriptPath} should exist`).toBe(true);

    const source = readFileSync(scriptPath, 'utf8');
    expect(source).toContain('createSession');
    expect(source).toContain('allowedTools: []');
    expect(source).toContain('observability: { enabled: true }');
    expect(source).toContain('session.stream()');
    expect(source).toContain('session.getLastTrace()');
    expect(source).toContain("trace.events.map((event) => event.type)");
    expect(source).toContain("'model_request'");
    expect(source).toContain("'turn_end'");
  });
});
