import path from 'node:path';
import picomatch from 'picomatch';
import type { SkillActivationContext, SkillMetadata } from './types.js';

function normalizePathCandidate(candidate: string): string {
  const normalized = candidate.replace(/\\/g, '/').trim();
  return normalized.replace(/^\.\/+/, '');
}

function stripCandidatePunctuation(candidate: string): string {
  return candidate.replace(/^[("'`]+|[)"'`,.:;!?]+$/g, '');
}

function toRelativeIfInside(candidate: string, cwd?: string): string | undefined {
  if (!cwd || !path.isAbsolute(candidate)) {
    return undefined;
  }

  const relative = path.relative(cwd, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return undefined;
  }

  return normalizePathCandidate(relative);
}

function extractPathCandidatesFromArgs(args?: string): string[] {
  if (!args?.trim()) {
    return [];
  }

  const tokens = args
    .split(/[\s,]+/)
    .map((token) => stripCandidatePunctuation(token.trim()))
    .filter(Boolean);

  return tokens.filter((token) => {
    if (token.includes('/')) {
      return true;
    }

    if (token === '.' || token === '..' || token.startsWith('./') || token.startsWith('../')) {
      return true;
    }

    const extension = path.extname(token);
    return /^\.[a-z0-9]{1,10}$/i.test(extension);
  });
}

export function collectSkillActivationPaths(context?: SkillActivationContext): string[] {
  if (!context) {
    return [];
  }

  const candidates = new Set<string>();
  const rawCandidates = [
    ...(context.referencedPaths ?? []),
    ...extractPathCandidatesFromArgs(context.args),
  ];

  for (const rawCandidate of rawCandidates) {
    const trimmed = stripCandidatePunctuation(rawCandidate);
    if (!trimmed) {
      continue;
    }

    const normalized = normalizePathCandidate(trimmed);
    if (normalized) {
      candidates.add(normalized);
    }

    const relative = toRelativeIfInside(trimmed, context.cwd);
    if (relative) {
      candidates.add(relative);
    }
  }

  return Array.from(candidates);
}

export function isSkillAvailableInContext(
  skill: SkillMetadata,
  context?: SkillActivationContext,
): boolean {
  const patterns = skill.conditions?.paths?.map((pattern) => pattern.trim()).filter(Boolean);
  if (!patterns || patterns.length === 0) {
    return true;
  }

  const candidates = collectSkillActivationPaths(context);
  if (candidates.length === 0) {
    return false;
  }

  const matchers = patterns.map((pattern) => picomatch(pattern, { dot: true }));
  return candidates.some((candidate) => matchers.some((matcher) => matcher(candidate)));
}

export function filterSkillsByActivation(
  skills: SkillMetadata[],
  context?: SkillActivationContext,
): SkillMetadata[] {
  return skills.filter((skill) => isSkillAvailableInContext(skill, context));
}
