#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { isExactDependencyVersion, isInternalBladeDependency } from './dependency-version-rules.mjs';
import {
  allowedPublicExportConditions,
  getManifestRootExportConditions,
  isBrowserConditionBeforeImport,
  isExactPackageJsonManifestExport,
  isTypesConditionFirst,
  verifyExportSubpathShape,
} from './package-export-rules.mjs';

const rootDir = process.cwd();
const pinnedDependencySections = ['dependencies', 'devDependencies', 'optionalDependencies'];

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

const expectedSdkBrowserExportTargets = {
  '.': './dist/browser/index.js',
  './browser': './dist/browser/index.js',
  './core': './dist/core/index.js',
  './errors': './dist/errors/index.js',
  './tools': './dist/tools/index.js',
  './server': './dist/browser/server-only-stub.js',
  './session': './dist/browser/server-only-stub.js',
  './session/internal': './dist/browser/server-only-stub.js',
  './local': './dist/browser/server-only-stub.js',
};

const rootSourceRules = [
  {
    name: 'legacy root source',
    sourceDir: 'src',
    disallowedSpecifiers: [
      [/^@\//, 'Legacy root source must use explicit relative imports instead of workspace path aliases'],
    ],
  },
];

const allowedRootSessionInternalConsumers = new Set([
  'src/agent/StreamingToolExecutor.ts',
  'src/agent/loop/executeToolCalls.ts',
  'src/agent/loop/runToolCall.ts',
  'src/agent/loop/runTurn.ts',
  'src/agent/loop/streamChatResponse.ts',
]);

const rootScopedSourceRules = [
  {
    name: 'legacy root provider-helper consumers',
    sourceDirs: ['src/session', 'src/agent'],
    disallowedSpecifiers: [
      [
        /(?:^|\/)services\/deepseek\.js$/,
        'Legacy root provider-helper consumers must import DeepSeek provider helpers from @blade-ai/ai/deepseek',
      ],
    ],
  },
];

const scopedSourceRules = [
  {
    name: 'Browser-safe SDK source',
    sourceDirs: [
      'packages/agent-sdk/src/browser',
      'packages/agent-sdk/src/core',
      'packages/agent-sdk/src/errors',
      'packages/agent-sdk/src/tools',
    ],
    disallowedSpecifiers: [
      [/^node:/, 'Browser-safe SDK source must not import Node-only modules'],
      [/^(?:fs|child_process|worker_threads)$/, 'Browser-safe SDK source must not import Node-only modules'],
      [/^@modelcontextprotocol(?:\/|$)/, 'Browser-safe SDK source must not import MCP runtime modules'],
      [/^undici$/, 'Browser-safe SDK source must not import server HTTP runtime modules'],
      [/^@vscode\/ripgrep$/, 'Browser-safe SDK source must not import local filesystem tooling'],
      [/^node-pty$/, 'Browser-safe SDK source must not import local terminal tooling'],
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

function collectBuildEntryMap(packageJsonPath) {
  const packageDir = dirname(packageJsonPath);
  const configPath = join(packageDir, 'tsup.config.ts');
  if (!existsSync(configPath)) return null;

  const entries = extractTsupEntries(readFileSync(configPath, 'utf-8'));
  if (!entries || entries.length === 0) return null;

  return new Map(entries.map((entry) => [entry.name, entry.path]));
}

function distTargetToBuildEntryName(target) {
  if (!target.startsWith('./dist/')) return null;

  const distPath = target.slice('./dist/'.length);
  if (distPath.endsWith('.d.ts')) return distPath.slice(0, -'.d.ts'.length);
  if (distPath.endsWith('.js')) return distPath.slice(0, -'.js'.length);
  return null;
}

function hasSourceEntryForDistTarget(packageJsonPath, target) {
  const entryName = distTargetToBuildEntryName(target);
  if (!entryName) return false;

  const buildEntries = collectBuildEntryMap(packageJsonPath);
  const entryPath = buildEntries?.get(entryName);
  if (!entryPath) return false;

  const packageDir = dirname(packageJsonPath);
  const resolvedEntry = normalize(resolve(packageDir, entryPath));
  return existsSync(resolvedEntry);
}

function verifyManifestTargetSourceEntry({ packageJson, packageJsonPath, label, target }) {
  if (typeof target !== 'string') return null;
  if (target === './package.json') return null;
  if (!target.startsWith('./dist/')) return null;

  if (!hasSourceEntryForDistTarget(packageJsonPath, target)) {
    return `${packageJson}: ${label} target "${target}" source manifest target must be backed by a tsup source entry`;
  }
  return null;
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

function isSourceArtifactTarget(target) {
  return target.startsWith('./src/') || target.includes('/src/');
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

function resolvePackageTarget(packageJsonPath, target) {
  return normalize(resolve(dirname(packageJsonPath), target));
}

function verifyManifestTargetExists({ packageJson, packageJsonPath, label, target }) {
  if (typeof target !== 'string') return null;
  if (target === './package.json') return null;
  if (!target.startsWith('./')) {
    return `${packageJson}: ${label} target "${target}" source manifest target must stay package-relative`;
  }
  if (isSourceArtifactTarget(target)) {
    return `${packageJson}: ${label} target "${target}" source manifest target must not point at source files`;
  }

  const packageDir = dirname(packageJsonPath);
  const resolvedTarget = resolvePackageTarget(packageJsonPath, target);
  if (!isWithin(resolvedTarget, packageDir)) {
    return `${packageJson}: ${label} target "${target}" source manifest target must not escape the package`;
  }
  if (!isWithin(resolvedTarget, resolve(packageDir, 'dist'))) {
    return `${packageJson}: ${label} target "${target}" source manifest target must stay inside package dist output`;
  }
  const sourceEntryViolation = verifyManifestTargetSourceEntry({
    packageJson,
    packageJsonPath,
    label,
    target,
  });
  if (sourceEntryViolation) {
    return sourceEntryViolation;
  }
  if (!existsSync(resolvedTarget)) {
    return null;
  }
  return null;
}

function verifySdkBrowserExportTargets({ packageJson, exportsValue }) {
  const browserTargetViolations = [];
  if (!exportsValue || typeof exportsValue !== 'object' || Array.isArray(exportsValue)) {
    return browserTargetViolations;
  }

  for (const [subpath, expectedTarget] of Object.entries(expectedSdkBrowserExportTargets)) {
    const exportValue = exportsValue[subpath];
    if (exportValue === undefined && subpath !== '.') continue;
    if (!exportValue || typeof exportValue !== 'object' || Array.isArray(exportValue)) continue;
    if (exportValue.browser !== expectedTarget) {
      browserTargetViolations.push(
        `${packageJson}: export "${subpath}" browser condition must point at ${expectedTarget}`,
      );
    }
  }

  return browserTargetViolations;
}

function isPinnedDependencyVersion(versionSpec) {
  if (typeof versionSpec !== 'string') return false;
  if (versionSpec === 'workspace:*') return true;
  if (versionSpec.startsWith('workspace:')) {
    return isExactDependencyVersion(versionSpec.slice('workspace:'.length));
  }
  if (versionSpec.startsWith('npm:')) {
    const versionStart = versionSpec.lastIndexOf('@');
    return versionStart > 'npm:'.length && isExactDependencyVersion(versionSpec.slice(versionStart + 1));
  }
  return isExactDependencyVersion(versionSpec);
}

function collectPinnedDependencyViolations(packageJson, manifest) {
  const dependencyViolations = [];
  for (const section of pinnedDependencySections) {
    const dependencies = manifest[section] ?? {};
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
    for (const [dependencyName, versionSpec] of Object.entries(dependencies)) {
      if (isInternalBladeDependency(dependencyName) && versionSpec !== 'workspace:*') {
        dependencyViolations.push(
          `${packageJson}: ${section} "${dependencyName}" internal @blade-ai dependencies must use workspace:* (found "${versionSpec}")`,
        );
        continue;
      }
      if (!isPinnedDependencyVersion(versionSpec)) {
        dependencyViolations.push(
          `${packageJson}: ${section} "${dependencyName}" must use an exact dependency version or workspace:* (found "${versionSpec}")`,
        );
      }
    }
  }
  return dependencyViolations;
}

function resolvesInsidePackageSource(file, specifier) {
  if (!specifier.startsWith('.')) return null;

  const resolved = normalize(resolve(dirname(file), specifier));
  for (const rule of rules) {
    const packageSourceDir = resolve(rootDir, rule.sourceDir);
    if (isWithin(resolved, packageSourceDir)) {
      return rule.sourceDir;
    }
  }
  return null;
}

function sourceFileCandidates(resolvedPath) {
  const cleanPath = resolvedPath.split(/[?#]/, 1)[0];
  const replacements = [
    [/\.js$/i, '.ts'],
    [/\.js$/i, '.tsx'],
    [/\.mjs$/i, '.mts'],
    [/\.cjs$/i, '.cts'],
    [/\.jsx$/i, '.tsx'],
  ];
  const candidates = [cleanPath];
  for (const [pattern, replacement] of replacements) {
    if (pattern.test(cleanPath)) {
      candidates.push(cleanPath.replace(pattern, replacement));
    }
  }
  if (!/\.[A-Za-z0-9]+$/.test(cleanPath)) {
    candidates.push(
      `${cleanPath}.ts`,
      `${cleanPath}.tsx`,
      `${cleanPath}.mts`,
      `${cleanPath}.cts`,
      join(cleanPath, 'index.ts'),
      join(cleanPath, 'index.tsx'),
      join(cleanPath, 'index.mts'),
      join(cleanPath, 'index.cts'),
    );
  }
  return candidates;
}

function resolveRelativeSourceFile(file, specifier, packageSourceDir) {
  if (!specifier.startsWith('.')) return null;

  const resolved = normalize(resolve(dirname(file), specifier));
  if (!isWithin(resolved, packageSourceDir)) return null;

  for (const candidate of sourceFileCandidates(resolved)) {
    if (isWithin(candidate, packageSourceDir) && existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function collectStaticImportClosure(entryFiles, packageSourceDir) {
  const seen = new Set();
  const pending = [...entryFiles];

  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(file, 'utf-8');
    for (const specifier of extractSpecifiers(source)) {
      const resolved = resolveRelativeSourceFile(file, specifier, packageSourceDir);
      if (resolved && !seen.has(resolved)) {
        pending.push(resolved);
      }
    }
  }

  return [...seen];
}

const violations = [];

const rootPackageJsonPath = resolve(rootDir, 'package.json');
if (existsSync(rootPackageJsonPath)) {
  const rootManifest = JSON.parse(readFileSync(rootPackageJsonPath, 'utf-8'));
  violations.push(...collectPinnedDependencyViolations('package.json', rootManifest));
}

for (const rule of manifestRules) {
  const packageJsonPath = resolve(rootDir, rule.packageJson);
  if (!existsSync(packageJsonPath)) {
    violations.push(`${rule.name}: missing package manifest ${rule.packageJson}`);
    continue;
  }

  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  violations.push(...collectPinnedDependencyViolations(rule.packageJson, manifest));
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
    if (typeof target !== 'string') {
      if (field === 'main') {
        violations.push(`${rule.packageJson}: main field must declare a package root runtime entry`);
      } else {
        violations.push(`${rule.packageJson}: types field must declare a package root declaration entry`);
      }
      continue;
    }
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
    const existenceViolation = verifyManifestTargetExists({
      packageJson: rule.packageJson,
      packageJsonPath,
      label: field,
      target,
    });
    if (existenceViolation) {
      violations.push(existenceViolation);
    }
  }

  const rootExport = getManifestRootExportConditions(manifest.exports);
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
  if (manifest.exports?.['./package.json'] === undefined) {
    violations.push(`${rule.packageJson}: must expose "./package.json" metadata export`);
  } else if (!isExactPackageJsonManifestExport('./package.json', manifest.exports['./package.json'])) {
    violations.push(`${rule.packageJson}: metadata export must be exactly {"default":"./package.json"}`);
  }

  for (const [subpath, exportValue] of collectExportEntries(manifest.exports)) {
    const subpathViolation = verifyExportSubpathShape({
      prefix: `${rule.packageJson}:`,
      subpath,
    });
    if (subpathViolation) {
      violations.push(subpathViolation);
    }
    if (isExactPackageJsonManifestExport(subpath, exportValue)) continue;
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
      const existenceViolation = verifyManifestTargetExists({
        packageJson: rule.packageJson,
        packageJsonPath,
        label: `export "${subpath}" ${condition}`,
        target: exportValue[condition],
      });
      if (existenceViolation) {
        violations.push(existenceViolation);
      }
    }
  }

  if (rule.name === '@blade-ai/agent-sdk') {
    violations.push(...verifySdkBrowserExportTargets({
      packageJson: rule.packageJson,
      exportsValue: manifest.exports,
    }));
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

for (const rule of rootSourceRules) {
  const sourceDir = resolve(rootDir, rule.sourceDir);
  if (!existsSync(sourceDir)) continue;

  for (const file of listSourceFiles(sourceDir)) {
    const source = readFileSync(file, 'utf-8');
    const displayPath = relative(rootDir, file);
    for (const specifier of extractSpecifiers(source)) {
      for (const [pattern, reason] of rule.disallowedSpecifiers) {
        if (pattern.test(specifier)) {
          violations.push(`${displayPath}: disallowed import "${specifier}" - ${reason}`);
        }
      }
      const packageSourceDir = resolvesInsidePackageSource(file, specifier);
      if (packageSourceDir) {
        violations.push(
          `${displayPath}: disallowed import "${specifier}" reaches ${packageSourceDir} - Legacy root source must import package public subpaths instead of package source files`,
        );
      }
      if (
        specifier === '@blade-ai/agent-sdk/session/internal'
        && !allowedRootSessionInternalConsumers.has(displayPath)
      ) {
        violations.push(
          `${displayPath}: disallowed import "${specifier}" - the migration-only session internal subpath is restricted to root legacy loop adapters`,
        );
      }
    }
  }
}

for (const rule of rootScopedSourceRules) {
  for (const ruleSourceDir of rule.sourceDirs) {
    const sourceDir = resolve(rootDir, ruleSourceDir);
    if (!existsSync(sourceDir)) continue;

    for (const file of listSourceFiles(sourceDir)) {
      const source = readFileSync(file, 'utf-8');
      const displayPath = relative(rootDir, file);
      for (const specifier of extractSpecifiers(source)) {
        for (const [pattern, reason] of rule.disallowedSpecifiers) {
          if (pattern.test(specifier)) {
            violations.push(`${displayPath}: disallowed import "${specifier}" - ${reason}`);
          }
        }
      }
    }
  }
}

for (const rule of scopedSourceRules) {
  const packageSourceDir = resolve(rootDir, 'packages/agent-sdk/src');
  for (const ruleSourceDir of rule.sourceDirs) {
    const sourceDir = resolve(rootDir, ruleSourceDir);
    if (!existsSync(sourceDir)) continue;

    for (const file of collectStaticImportClosure(listSourceFiles(sourceDir), packageSourceDir)) {
      const source = readFileSync(file, 'utf-8');
      const displayPath = relative(rootDir, file);
      for (const specifier of extractSpecifiers(source)) {
        for (const [pattern, reason] of rule.disallowedSpecifiers) {
          if (pattern.test(specifier)) {
            violations.push(
              `${displayPath}: disallowed import "${specifier}" - ${rule.name} static closure ${reason}`,
            );
          }
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
