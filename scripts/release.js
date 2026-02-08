#!/usr/bin/env node

import chalk from 'chalk';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageDir = join(__dirname, '..');
const packageJsonPath = join(packageDir, 'package.json');
const changelogPath = join(packageDir, 'CHANGELOG.md');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const allowDirty = args.includes('--allow-dirty');
const skipTests = args.includes('--skip-tests');
const skipBuild = args.includes('--skip-build');
const releaseType =
  args.find(arg => ['--major', '--minor', '--patch'].includes(arg))?.replace('--', '') || 'patch';

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const currentVersion = packageJson.version;
const tagPrefix = process.env.RELEASE_TAG_PREFIX || 'v';

function exec(command, options = {}) {
  if (isDryRun && !options.allowInDryRun) {
    console.log(chalk.cyan(`[DRY RUN] ${command}`));
    return '';
  }
  try {
    return execSync(command, {
      encoding: 'utf8',
      cwd: options.cwd || packageDir,
      stdio: 'pipe',
      ...options,
    }).trim();
  } catch (error) {
    if (options.allowFailure) return null;
    throw error;
  }
}

function findRepoRoot(startDir) {
  let dir = startDir;
  while (dir && dir !== dirname(dir)) {
    if (
      existsSync(join(dir, 'pnpm-lock.yaml')) ||
      existsSync(join(dir, 'yarn.lock')) ||
      existsSync(join(dir, 'package-lock.json'))
    ) {
      return dir;
    }
    dir = dirname(dir);
  }
  return startDir;
}

const repoRoot = findRepoRoot(packageDir);
const packageJsonRelPath = relative(repoRoot, packageJsonPath);
const changelogRelPath = relative(repoRoot, changelogPath);

function detectPackageManager() {
  if (existsSync(join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(repoRoot, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

const packageManager = detectPackageManager();

console.log(chalk.blue('🚀 agent-sdk 发布脚本'));
console.log(chalk.gray(`当前版本: ${currentVersion}`));
console.log(chalk.gray(`发布类型: ${releaseType}`));
console.log(chalk.gray(`包管理器: ${packageManager}`));
if (isDryRun) {
  console.log(chalk.yellow('🏃 预演模式 (不会实际发布)'));
}

function checkWorkingDirectory() {
  const status = exec('git status --porcelain', { cwd: repoRoot, allowInDryRun: true });
  if (status && !allowDirty) {
    console.log(chalk.red('❌ 工作目录有未提交的更改'));
    console.log(status);
    if (!isDryRun) process.exit(1);
  }
}

function getLatestTag() {
  const tag = exec('git describe --tags --abbrev=0', {
    cwd: repoRoot,
    allowFailure: true,
    allowInDryRun: true,
  });
  return tag || `${tagPrefix}0.0.0`;
}

function compareVersions(v1, v2) {
  const parts1 = v1.replace(new RegExp(`^${tagPrefix}`), '').split('.').map(Number);
  const parts2 = v2.replace(new RegExp(`^${tagPrefix}`), '').split('.').map(Number);
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const a = parts1[i] || 0;
    const b = parts2[i] || 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

function incrementVersion(version, type) {
  const cleanVersion = version.replace(new RegExp(`^${tagPrefix}`), '');
  const parts = cleanVersion.split('.').map(Number);
  switch (type) {
    case 'major':
      parts[0] += 1;
      parts[1] = 0;
      parts[2] = 0;
      break;
    case 'minor':
      parts[1] += 1;
      parts[2] = 0;
      break;
    default:
      parts[2] += 1;
  }
  return parts.join('.');
}

async function checkNpmVersion() {
  const npmInfo = exec(`npm view ${packageJson.name} version`, {
    allowFailure: true,
    allowInDryRun: true,
  });
  return npmInfo || null;
}

async function determineNewVersion() {
  const latestTag = getLatestTag().replace(new RegExp(`^${tagPrefix}`), '');
  const npmVersion = await checkNpmVersion();
  let maxVersion = currentVersion;
  if (compareVersions(latestTag, maxVersion) > 0) maxVersion = latestTag;
  if (npmVersion && compareVersions(npmVersion, maxVersion) > 0) maxVersion = npmVersion;
  return incrementVersion(maxVersion, releaseType);
}

function ensureChangelog() {
  if (!existsSync(changelogPath)) {
    const initial = ['# Changelog', '', '本文件记录 @blade-ai/agent-sdk 的所有重要变更。', ''].join('\n');
    if (!isDryRun) {
      writeFileSync(changelogPath, `${initial}\n`);
    }
  }
}

function generateChangelog(newVersion) {
  ensureChangelog();
  const latestTag = getLatestTag();
  const date = new Date().toISOString().split('T')[0];
  const packagePath = relative(repoRoot, packageDir) || '.';
  const tagExists = exec(`git rev-parse --verify ${latestTag}`, {
    cwd: repoRoot,
    allowFailure: true,
    allowInDryRun: true,
  });
  const commitRange = tagExists ? `${latestTag}..HEAD` : 'HEAD~20..HEAD';
  const commits = exec(
    `git log ${commitRange} --pretty=format:"%h %s" --no-merges -- ${packagePath}`,
    { cwd: repoRoot, allowInDryRun: true, allowFailure: true }
  );
  const lines = commits ? commits.split('\n').filter(Boolean) : [];
  const changes = lines.length
    ? lines.map(line => `- ${line}`).join('\n')
    : '- 无相关变更';
  const block = [`## [${newVersion}] - ${date}`, '', changes, ''].join('\n');
  const existing = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';
  const insertIndex = existing.indexOf('## [');
  const content =
    insertIndex >= 0
      ? `${existing.slice(0, insertIndex)}${block}${existing.slice(insertIndex)}`
      : `${existing}\n${block}`;
  if (isDryRun) {
    console.log(chalk.cyan('📋 预览 changelog 更新内容:'));
    console.log(block);
    return;
  }
  writeFileSync(changelogPath, content.trimEnd() + '\n');
}

function updatePackageVersion(newVersion) {
  if (isDryRun) {
    console.log(chalk.cyan(`[DRY RUN] 更新版本 ${currentVersion} -> ${newVersion}`));
    return;
  }
  packageJson.version = newVersion;
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
}

function buildProject() {
  if (skipBuild) {
    console.log(chalk.gray('跳过构建'));
    return;
  }
  exec(`${packageManager} run build`);
}

function runTests() {
  if (skipTests) {
    console.log(chalk.gray('跳过测试'));
    return;
  }
  if (packageJson.scripts?.test) {
    exec(`${packageManager} test`, { allowInDryRun: true });
  }
}

function commitAndTag(newVersion) {
  const tag = `${tagPrefix}${newVersion}`;
  exec(`git add ${packageJsonRelPath} ${changelogRelPath}`, { cwd: repoRoot });
  exec(`git commit -m "chore: release ${tag}"`, { cwd: repoRoot });
  exec(`git tag ${tag}`, { cwd: repoRoot });
}

function publishToNpm() {
  exec('npm publish --access public');
}

function pushToRemote() {
  exec('git push', { cwd: repoRoot });
  exec('git push --tags', { cwd: repoRoot });
}

async function main() {
  try {
    checkWorkingDirectory();
    const newVersion = await determineNewVersion();
    generateChangelog(newVersion);
    updatePackageVersion(newVersion);
    buildProject();
    runTests();
    if (isDryRun) {
      console.log(chalk.yellow('🏃 预演完成'));
      return;
    }
    commitAndTag(newVersion);
    publishToNpm();
    pushToRemote();
    console.log(chalk.green(`✅ 已发布 ${packageJson.name}@${newVersion}`));
  } catch (error) {
    console.log(chalk.red('❌ 发布失败:'), error.message);
    process.exit(1);
  }
}

main();
