import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { CustomCommand, CustomCommandConfig } from './types.js';

export class CommandParser {
  parse(
    filePath: string,
    basePath: string,
    source: 'user' | 'project',
    sourceDir: 'claude' | 'blade'
  ): CustomCommand | null {
    try {
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const { data, content: body } = matter(fileContent);

      const { name, namespace } = this.extractNameAndNamespace(filePath, basePath);

      if (!name) {
        return null;
      }

      return {
        name,
        namespace,
        config: this.normalizeConfig(data),
        content: body.trim(),
        path: filePath,
        source,
        sourceDir,
      };
    } catch {
      return null;
    }
  }

  private normalizeConfig(data: Record<string, unknown>): CustomCommandConfig {
    return {
      description: this.asString(data.description),
      allowedTools: this.parseAllowedTools(data['allowed-tools']),
      argumentHint: this.asString(data['argument-hint']),
      model: this.asString(data.model),
      disableModelInvocation: data['disable-model-invocation'] === true,
    };
  }

  private asString(value: unknown): string | undefined {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    return undefined;
  }

  private parseAllowedTools(value: unknown): string[] | undefined {
    if (!value) return undefined;

    if (Array.isArray(value)) {
      return value.map((item) => String(item).trim()).filter(Boolean);
    }

    if (typeof value === 'string') {
      return value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }

    return undefined;
  }

  private extractNameAndNamespace(
    filePath: string,
    basePath: string
  ): { name: string; namespace?: string } {
    const relativePath = path.relative(basePath, filePath);
    const parts = relativePath.split(path.sep);
    const fileName = parts.pop();

    if (!fileName) {
      return { name: '' };
    }

    const name = fileName.replace(/\.md$/i, '');
    const namespace = parts.length > 0 ? parts.join('/') : undefined;

    return { name, namespace };
  }

  validateConfig(config: CustomCommandConfig): string[] {
    const errors: string[] = [];

    if (config.model && !this.isValidModelId(config.model)) {
      errors.push(`Invalid model ID: ${config.model}`);
    }

    return errors;
  }

  private isValidModelId(model: string): boolean {
    return model.length > 0 && model.length < 200;
  }
}
