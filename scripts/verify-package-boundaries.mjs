#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';

const rootDir = process.cwd();
const allowedPublicExportConditions = new Set(['types', 'browser', 'import']);

const rules = [
  {
    name: '@blade-ai/ai',
    sourceDir: 'packages/ai/src',
    disallowedSpecifiers: [
      [/^@blade-ai\/ai(?:\/|$)/, 'AI package source must not import its own public facade'],
      [/^@blade-ai\/agent(?:\/|$)/, 'AI package must not depend on the agent kernel'],
      [/^@blade-ai\/agent-sdk(?:\/|$)/, 'AI package must not depend on the session SDK'],
    ],
  },
  {
    name: '@blade-ai/agent',
    sourceDir: 'packages/agent/src',
    disallowedSpecifiers: [
      [/^@blade-ai\/agent(?:\/|$)/, 'Agent kernel source must not import its own public facade'],
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
    disallowBin: true,
    disallowedExportSubpaths: [
      ['./cli', 'CLI product capabilities belong in a separate package'],
    ],
    disallowedKeywords: [
      ['cli', 'CLI product capabilities belong in a separate package'],
    ],
    disallowedDependencies: [
      [/^@blade-ai\/agent(?:\/|$)/, 'AI package must not depend on the agent kernel'],
      [/^@blade-ai\/agent-sdk(?:\/|$)/, 'AI package must not depend on the session SDK'],
    ],
  },
  {
    name: '@blade-ai/agent',
    packageJson: 'packages/agent/package.json',
    disallowBin: true,
    disallowedExportSubpaths: [
      ['./cli', 'CLI product capabilities belong in a separate package'],
    ],
    disallowedKeywords: [
      ['cli', 'CLI product capabilities belong in a separate package'],
    ],
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
    disallowBin: true,
    disallowedExportSubpaths: [
      ['./cli', 'CLI product capabilities belong in a separate package'],
    ],
    disallowedKeywords: [
      ['cli', 'CLI product capabilities belong in a separate package'],
    ],
    disallowedDependencies: [
      [/^@ai-sdk\/(?:anthropic|azure|deepseek|google|openai|openai-compatible)$/, 'Provider SDK dependencies belong in @blade-ai/ai, not the session SDK'],
      [/^ai$/, 'Provider runtime dependency belongs in @blade-ai/ai, not the session SDK'],
    ],
  },
];

const buildEntryRules = rules.map((rule) => ({
  name: rule.name,
  configPath: `${dirname(rule.sourceDir)}/tsup.config.ts`,
  sourceDir: rule.sourceDir,
}));

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

function hasExplicitRuntimeFileExtension(specifier) {
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
  const lastSegment = cleanSpecifier.split('/').at(-1) ?? '';
  if (!/\.[A-Za-z0-9]+$/.test(lastSegment)) {
    return false;
  }
  return !/\.(?:ts|tsx|mts|cts)$/i.test(lastSegment);
}

function findObjectLiteralBody(source, propertyName) {
  const propertyMatch = new RegExp(`\\b${propertyName}\\s*:`).exec(source);
  if (!propertyMatch) return null;

  const objectStart = source.indexOf('{', propertyMatch.index + propertyMatch[0].length);
  if (objectStart === -1) return null;

  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = objectStart; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(objectStart + 1, index);
      }
    }
  }

  return null;
}

function extractTsupEntries(source) {
  const entryBody = findObjectLiteralBody(source, 'entry');
  if (!entryBody) return null;

  const entries = [];
  const entryPattern = /(?:^|[,\n\r])\s*(?:(['"`])([^'"`]+)\1|([A-Za-z_$][\w$-]*))\s*:\s*(['"`])([^'"`]+)\4/g;
  for (const match of entryBody.matchAll(entryPattern)) {
    entries.push({
      name: match[2] ?? match[3],
      path: match[5],
    });
  }
  return entries;
}

function collectExportTargets(exportsValue, path = 'export') {
  if (typeof exportsValue === 'string') {
    return [{ path, target: exportsValue }];
  }
  if (!exportsValue || typeof exportsValue !== 'object' || Array.isArray(exportsValue)) {
    return [];
  }

  const targets = [];
  for (const [key, value] of Object.entries(exportsValue)) {
    const childPath = path === 'export' ? `export "${key}"` : `${path} ${key}`;
    targets.push(...collectExportTargets(value, childPath));
  }
  return targets;
}

function collectExportSubpaths(exportsValue) {
  if (!exportsValue || typeof exportsValue !== 'object' || Array.isArray(exportsValue)) {
    return [];
  }
  return Object.keys(exportsValue);
}

function collectExportEntries(exportsValue) {
  if (!exportsValue || typeof exportsValue !== 'object' || Array.isArray(exportsValue)) {
    return [];
  }
  return Object.entries(exportsValue);
}

function isDistArtifactTarget(target) {
  return target.startsWith('./dist/');
}

function isDeclarationArtifactTarget(target) {
  return target.endsWith('.d.ts');
}

function isRuntimeArtifactTarget(target) {
  return target.endsWith('.js');
}

function isPackageJsonExportTarget(path, target) {
  return path.startsWith('export "./package.json"') && target === './package.json';
}

function isPackageJsonExportEntry(subpath, exportValue) {
  return (
    subpath === './package.json' &&
    exportValue &&
    typeof exportValue === 'object' &&
    !Array.isArray(exportValue) &&
    exportValue.default === './package.json'
  );
}

function getRootExportConditions(exportsValue) {
  if (!exportsValue || typeof exportsValue !== 'object' || Array.isArray(exportsValue)) {
    return null;
  }
  const rootExport = exportsValue['.'];
  if (!rootExport || typeof rootExport !== 'object' || Array.isArray(rootExport)) {
    return null;
  }
  return rootExport;
}

function isTypesConditionFirst(exportValue) {
  return Object.keys(exportValue).at(0) === 'types';
}

function isBrowserConditionBeforeImport(exportValue) {
  const conditions = Object.keys(exportValue);
  const browserIndex = conditions.indexOf('browser');
  const importIndex = conditions.indexOf('import');
  return browserIndex === -1 || importIndex === -1 || browserIndex < importIndex;
}

function verifyManifestTargetExtension({ packageJson, label, condition, target }) {
  if (typeof target !== 'string') return null;
  if (target === './package.json') return null;

  if (condition === 'types' && !isDeclarationArtifactTarget(target)) {
    return `${packageJson}: ${label} target "${target}" must point at a .d.ts declaration artifact`;
  }
  if ((condition === 'import' || condition === 'browser') && !isRuntimeArtifactTarget(target)) {
    return `${packageJson}: ${label} target "${target}" must point at a .js runtime artifact`;
  }
  return null;
}

const violations = [];

for (const rule of manifestRules) {
  const packageJsonPath = resolve(rootDir, rule.packageJson);
  if (!existsSync(packageJsonPath)) {
    violations.push(`${rule.name}: missing package manifest ${rule.packageJson}`);
    continue;
  }

  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  if (rule.disallowBin && manifest.bin !== undefined) {
    violations.push(`${rule.packageJson}: bin field is not allowed - CLI product capabilities belong in a separate package`);
  }
  for (const [subpath, reason] of rule.disallowedExportSubpaths ?? []) {
    if (collectExportSubpaths(manifest.exports).includes(subpath)) {
      violations.push(`${rule.packageJson}: export "${subpath}" is not allowed - ${reason}`);
    }
  }
  for (const [keyword, reason] of rule.disallowedKeywords ?? []) {
    if (Array.isArray(manifest.keywords) && manifest.keywords.includes(keyword)) {
      violations.push(`${rule.packageJson}: keyword "${keyword}" is not allowed - ${reason}`);
    }
  }

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

  for (const field of ['main', 'types']) {
    const target = manifest[field];
    if (typeof target === 'string' && !isDistArtifactTarget(target)) {
      violations.push(`${rule.packageJson}: ${field} target "${target}" must point at ./dist artifacts`);
    }
    const extensionViolation = verifyManifestTargetExtension({
      packageJson: rule.packageJson,
      label: field,
      condition: field === 'types' ? 'types' : 'import',
      target,
    });
    if (extensionViolation) {
      violations.push(extensionViolation);
    }
  }

  const rootExport = getRootExportConditions(manifest.exports);
  if (!rootExport) {
    violations.push(`${rule.packageJson}: exports must declare a root "." condition object`);
  } else {
    if (typeof manifest.main === 'string' && typeof rootExport.import === 'string' && manifest.main !== rootExport.import) {
      violations.push(
        `${rule.packageJson}: main target "${manifest.main}" must match root export import target "${rootExport.import}"`,
      );
    }
    if (typeof manifest.types === 'string' && typeof rootExport.types === 'string' && manifest.types !== rootExport.types) {
      violations.push(
        `${rule.packageJson}: types target "${manifest.types}" must match root export types target "${rootExport.types}"`,
      );
    }
  }

  for (const [subpath, exportValue] of collectExportEntries(manifest.exports)) {
    if (isPackageJsonExportEntry(subpath, exportValue)) continue;
    if (!exportValue || typeof exportValue !== 'object' || Array.isArray(exportValue)) {
      violations.push(`${rule.packageJson}: export "${subpath}" must be a condition object`);
      continue;
    }
    if (typeof exportValue.types !== 'string') {
      violations.push(`${rule.packageJson}: export "${subpath}" must declare a types condition`);
    }
    if (typeof exportValue.import !== 'string') {
      violations.push(`${rule.packageJson}: export "${subpath}" must declare an import condition`);
    }
    if (typeof exportValue.types === 'string' && !isTypesConditionFirst(exportValue)) {
      violations.push(`${rule.packageJson}: export "${subpath}" must declare the types condition first`);
    }
    if (!isBrowserConditionBeforeImport(exportValue)) {
      violations.push(`${rule.packageJson}: export "${subpath}" must declare the browser condition before import`);
    }
    for (const condition of Object.keys(exportValue)) {
      if (!allowedPublicExportConditions.has(condition)) {
        violations.push(`${rule.packageJson}: export "${subpath}" condition "${condition}" is not allowed`);
      }
      const extensionViolation = verifyManifestTargetExtension({
        packageJson: rule.packageJson,
        label: `export "${subpath}" ${condition}`,
        condition,
        target: exportValue[condition],
      });
      if (extensionViolation) {
        violations.push(extensionViolation);
      }
    }
  }

  for (const { path, target } of collectExportTargets(manifest.exports)) {
    if (isPackageJsonExportTarget(path, target)) continue;
    if (!isDistArtifactTarget(target)) {
      violations.push(`${rule.packageJson}: ${path} target "${target}" must point at ./dist artifacts`);
    }
  }
}

for (const rule of buildEntryRules) {
  const configPath = resolve(rootDir, rule.configPath);
  if (!existsSync(configPath)) {
    violations.push(`${rule.name}: missing build config ${rule.configPath}`);
    continue;
  }

  const entries = extractTsupEntries(readFileSync(configPath, 'utf-8'));
  if (!entries || entries.length === 0) {
    violations.push(`${rule.configPath}: missing static tsup entry map`);
    continue;
  }

  const packageRoot = dirname(configPath);
  const packageSourceDir = resolve(rootDir, rule.sourceDir);
  for (const entry of entries) {
    const resolved = normalize(resolve(packageRoot, entry.path));
    if (!isWithin(resolved, packageSourceDir)) {
      violations.push(`${rule.configPath}: build entry "${entry.name}" -> "${entry.path}" leaves ${rule.sourceDir}`);
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
        if (!hasExplicitRuntimeFileExtension(specifier)) {
          violations.push(
            `${displayPath}: relative import "${specifier}" must include an explicit runtime file extension`,
          );
        }

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
