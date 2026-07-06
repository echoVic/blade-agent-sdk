#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';

const rootDir = process.cwd();

const rules = [
  {
    name: '@blade-ai/ai',
    sourceDir: 'packages/ai/src',
    disallowedSpecifiers: [
      [/^@blade-ai\/agent(?:\/|$)/, 'AI package must not depend on the agent kernel'],
      [/^@blade-ai\/agent-sdk(?:\/|$)/, 'AI package must not depend on the session SDK'],
    ],
  },
  {
    name: '@blade-ai/agent',
    sourceDir: 'packages/agent/src',
    disallowedSpecifiers: [
      [/^@blade-ai\/agent-sdk(?:\/|$)/, 'Agent kernel must not depend on the session SDK'],
      [/^node:/, 'Agent kernel must stay runtime independent and avoid node:* imports'],
      [/^(?:fs|node:fs|child_process|node:child_process|worker_threads|node:worker_threads)$/, 'Agent kernel must avoid Node-local runtime modules'],
      [/^@modelcontextprotocol(?:\/|$)/, 'Agent kernel must not depend on MCP SDKs'],
    ],
  },
  {
    name: '@blade-ai/agent-sdk',
    sourceDir: 'packages/agent-sdk/src',
    disallowedSpecifiers: [
      [/^@blade-ai\/agent-sdk(?:\/|$)/, 'Session SDK source must not import its own public facade'],
    ],
  },
];

const manifestRules = [
  {
    name: '@blade-ai/ai',
    packageJson: 'packages/ai/package.json',
    disallowedDependencies: [
      [/^@blade-ai\/agent(?:\/|$)/, 'AI package must not depend on the agent kernel'],
      [/^@blade-ai\/agent-sdk(?:\/|$)/, 'AI package must not depend on the session SDK'],
    ],
  },
  {
    name: '@blade-ai/agent',
    packageJson: 'packages/agent/package.json',
    disallowedDependencies: [
      [/^@blade-ai\/agent-sdk(?:\/|$)/, 'Agent kernel must not depend on the session SDK'],
      [/^@modelcontextprotocol(?:\/|$)/, 'Agent kernel must not depend on MCP SDKs'],
      [/^@ai-sdk(?:\/|$)/, 'Agent kernel must not depend on provider SDK implementations'],
      [/^ai$/, 'Agent kernel must not depend on provider runtime implementations'],
      [/^@vscode\/ripgrep$/, 'Agent kernel must not depend on local filesystem tooling'],
      [/^node-pty$/, 'Agent kernel must not depend on local terminal tooling'],
      [/^fast-glob$/, 'Agent kernel must not depend on local filesystem traversal tooling'],
      [/^undici$/, 'Agent kernel must not depend on server HTTP runtime tooling'],
      [/^write-file-atomic$/, 'Agent kernel must not depend on filesystem storage implementations'],
    ],
  },
  {
    name: '@blade-ai/agent-sdk',
    packageJson: 'packages/agent-sdk/package.json',
    disallowedDependencies: [
      [/^@ai-sdk\/(?:anthropic|azure|deepseek|google|openai|openai-compatible)$/, 'Provider SDK dependencies belong in @blade-ai/ai, not the session SDK'],
      [/^ai$/, 'Provider runtime dependency belongs in @blade-ai/ai, not the session SDK'],
    ],
  },
];

const importPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function listSourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === '__tests__' || entry === 'dist' || entry === 'node_modules') continue;
      files.push(...listSourceFiles(fullPath));
      continue;
    }
    if (!/\.(?:ts|tsx|mts|cts)$/.test(entry)) continue;
    if (/\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/.test(entry)) continue;
    files.push(fullPath);
  }
  return files;
}

function extractSpecifiers(source) {
  const specifiers = [];
  importPattern.lastIndex = 0;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

function isWithin(childPath, parentPath) {
  const rel = relative(parentPath, childPath);
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`));
}

const violations = [];

for (const rule of manifestRules) {
  const packageJsonPath = resolve(rootDir, rule.packageJson);
  if (!existsSync(packageJsonPath)) {
    violations.push(`${rule.name}: missing package manifest ${rule.packageJson}`);
    continue;
  }

  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  const dependencySections = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  for (const section of dependencySections) {
    const dependencies = manifest[section] ?? {};
    for (const dependencyName of Object.keys(dependencies)) {
      for (const [pattern, reason] of rule.disallowedDependencies) {
        if (pattern.test(dependencyName)) {
          violations.push(`${rule.packageJson}: disallowed ${section} "${dependencyName}" - ${reason}`);
        }
      }
    }
  }
}

for (const rule of rules) {
  const packageSourceDir = resolve(rootDir, rule.sourceDir);
  if (!existsSync(packageSourceDir)) {
    violations.push(`${rule.name}: missing source directory ${rule.sourceDir}`);
    continue;
  }

  for (const file of listSourceFiles(packageSourceDir)) {
    const source = readFileSync(file, 'utf-8');
    const displayPath = relative(rootDir, file);
    for (const specifier of extractSpecifiers(source)) {
      for (const [pattern, reason] of rule.disallowedSpecifiers) {
        if (pattern.test(specifier)) {
          violations.push(`${displayPath}: disallowed import "${specifier}" - ${reason}`);
        }
      }

      if (specifier.startsWith('.')) {
        const resolved = normalize(resolve(dirname(file), specifier));
        if (!isWithin(resolved, packageSourceDir)) {
          violations.push(`${displayPath}: relative import "${specifier}" leaves ${rule.sourceDir}`);
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Package boundary verification failed:');
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log('package boundary verification passed');
