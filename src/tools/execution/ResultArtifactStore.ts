import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ExecutionContext } from '../types/index.js';

export interface PersistedToolResultArtifact {
  path: string;
}

export class ResultArtifactStore {
  async persist(options: {
    executionId: string;
    toolName: string;
    sessionId?: string;
    context: ExecutionContext;
    llmContent?: string;
    displayContent?: string;
  }): Promise<PersistedToolResultArtifact> {
    const baseDir = await this.resolveBaseDir(options.context);
    await fs.mkdir(baseDir, { recursive: true });

    const fileName = `${sanitizeSegment(options.sessionId ?? options.executionId)}-${sanitizeSegment(options.toolName)}-${Date.now()}.json`;
    const artifactPath = path.join(baseDir, fileName);

    await fs.writeFile(artifactPath, JSON.stringify({
      toolName: options.toolName,
      sessionId: options.sessionId,
      llmContent: options.llmContent,
      displayContent: options.displayContent,
      createdAt: new Date().toISOString(),
    }, null, 2), 'utf8');

    return { path: artifactPath };
  }

  private async resolveBaseDir(context: ExecutionContext): Promise<string> {
    const cwd = context.contextSnapshot?.cwd;
    if (cwd) {
      return path.join(cwd, '.blade-tool-results');
    }

    return path.join(os.tmpdir(), 'blade-agent-sdk', 'tool-results');
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 64) || 'artifact';
}
