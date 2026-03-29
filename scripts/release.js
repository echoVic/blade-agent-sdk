#!/usr/bin/env node

import chalk from 'chalk';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { buildCommandFailureMessage, getPublishEnv } from './release-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageDir = join(__dirname, '..');
const packageJsonPath = join(packageDir, 'package.json');
const changelogPath = join(packageDir, 'CHANGELOG.md');
const publishCacheDir = join(tmpdir(), 'blade-agent-sdk-npm-cache');

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
const npmRegistry = 'https://registry.npmjs.org/';

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
    if (existsSync(join(dir, 'pnpm-lock.yaml')) && existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return startDir;
}

const repoRoot = findRepoRoot(packageDir);
const packageJsonRelPath = relative(repoRoot, packageJsonPath);
const changelogRelPath = relative(repoRoot, changelogPath);
const packageManager = 'pnpm';

console.log(chalk.blue('🚀 agent-sdk 发布脚本'));
console.log(chalk.gray(`当前版本: ${currentVersion}`));
console.log(chalk.gray(`发布类型: ${releaseType}`));
console.log(chalk.gray(`包管理器: ${packageManager}`));
if (isDryRun) {
  console.log(chalk.yellow('🏃 预演模式 (不会实际发布)'));
}

function checkWorkingDirectory() {
  console.log(chalk.blue('\n📋 步骤 1: 检查工作目录'));
  const status = exec('git status --porcelain', { cwd: repoRoot, allowInDryRun: true });
  if (status && !allowDirty) {
    console.log(chalk.red('❌ 工作目录有未提交的更改'));
    console.log(status);
    if (!isDryRun) process.exit(1);
  } else {
    console.log(chalk.green('  ✓ 工作目录干净'));
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
  const packageName = encodeURIComponent(packageJson.name);
  const response = await fetch(`${npmRegistry}${packageName}`, {
    headers: { Accept: 'application/json' },
  }).catch(() => null);

  if (!response || !response.ok) {
    return null;
  }

  const npmInfo = await response.json();
  return npmInfo?.['dist-tags']?.latest || null;
}

async function determineNewVersion() {
  console.log(chalk.blue('\n📋 步骤 2: 确定新版本号'));
  const latestTag = getLatestTag().replace(new RegExp(`^${tagPrefix}`), '');
  console.log(chalk.gray(`  最新 Git 标签: ${tagPrefix}${latestTag}`));
  const npmVersion = await checkNpmVersion();
  console.log(chalk.gray(`  NPM 当前版本: ${npmVersion || '未发布'}`));
  console.log(chalk.gray(`  package.json 版本: ${currentVersion}`));
  let maxVersion = currentVersion;
  if (compareVersions(latestTag, maxVersion) > 0) maxVersion = latestTag;
  if (npmVersion && compareVersions(npmVersion, maxVersion) > 0) maxVersion = npmVersion;
  const newVersion = incrementVersion(maxVersion, releaseType);
  console.log(chalk.green(`  ✓ 新版本: ${maxVersion} -> ${newVersion} (${releaseType})`));
  return newVersion;
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
  console.log(chalk.blue('\n📋 步骤 3: 生成 CHANGELOG'));
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
  console.log(chalk.gray(`  提交范围: ${commitRange}`));
  const commits = exec(
    `git log ${commitRange} --pretty=format:"%h %s" --no-merges -- ${packagePath}`,
    { cwd: repoRoot, allowInDryRun: true, allowFailure: true }
  );
  const lines = commits ? commits.split('\n').filter(Boolean) : [];
  console.log(chalk.gray(`  找到 ${lines.length} 个相关提交`));
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
    console.log(chalk.cyan('  预览 changelog 更新内容:'));
    console.log(chalk.gray(block));
    return;
  }
  writeFileSync(changelogPath, content.trimEnd() + '\n');
  console.log(chalk.green('  ✓ CHANGELOG.md 已更新'));
}

function updatePackageVersion(newVersion) {
  console.log(chalk.blue('\n📋 步骤 4: 更新 package.json 版本'));
  if (isDryRun) {
    console.log(chalk.cyan(`  [DRY RUN] 更新版本 ${currentVersion} -> ${newVersion}`));
    return;
  }
  packageJson.version = newVersion;
  writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
  console.log(chalk.green(`  ✓ 版本已更新: ${currentVersion} -> ${newVersion}`));
}

function buildProject() {
  console.log(chalk.blue('\n📋 步骤 5: 构建项目'));
  if (skipBuild) {
    console.log(chalk.yellow('  ⏭ 跳过构建'));
    return;
  }
  console.log(chalk.gray(`  执行: ${packageManager} run build`));
  exec(`${packageManager} run build`);
  console.log(chalk.green('  ✓ 构建完成'));
}

function runTests() {
  console.log(chalk.blue('\n📋 步骤 6: 运行测试'));
  if (skipTests) {
    console.log(chalk.yellow('  ⏭ 跳过测试'));
    return;
  }
  if (packageJson.scripts?.test) {
    console.log(chalk.gray(`  执行: ${packageManager} test`));
    exec(`${packageManager} test`, { allowInDryRun: true });
    console.log(chalk.green('  ✓ 测试通过'));
  } else {
    console.log(chalk.yellow('  ⏭ 未配置测试脚本'));
  }
}

function commitAndTag(newVersion) {
  console.log(chalk.blue('\n📋 步骤 7: Git 提交和标签'));
  const tag = `${tagPrefix}${newVersion}`;
  console.log(chalk.gray(`  执行: git add ${packageJsonRelPath} ${changelogRelPath}`));
  exec(`git add ${packageJsonRelPath} ${changelogRelPath}`, { cwd: repoRoot });
  console.log(chalk.gray(`  执行: git commit -m "chore: release ${tag}"`));
  exec(`git commit -m "chore: release ${tag}"`, { cwd: repoRoot });
  console.log(chalk.gray(`  执行: git tag ${tag}`));
  exec(`git tag ${tag}`, { cwd: repoRoot });
  console.log(chalk.green(`  ✓ 已创建提交和标签: ${tag}`));
}

function publishToNpm() {
  console.log(chalk.blue('\n📋 步骤 8: 发布到 NPM'));
  console.log(chalk.gray(`  执行: pnpm publish --access public --registry ${npmRegistry} --no-git-checks`));
  exec(`pnpm publish --access public --registry ${npmRegistry} --no-git-checks`, {
    env: getPublishEnv(publishCacheDir),
  });
  console.log(chalk.green('  ✓ 已发布到 NPM'));
}

function pushToRemote(newVersion) {
  const tag = `${tagPrefix}${newVersion}`;
  console.log(chalk.blue('\n📋 步骤 9: 推送到远程仓库'));
  console.log(chalk.gray('  执行: git push'));
  exec('git push', { cwd: repoRoot });
  console.log(chalk.gray(`  执行: git push origin ${tag}`));
  exec(`git push origin ${tag}`, { cwd: repoRoot });
  console.log(chalk.green('  ✓ 已推送到远程仓库'));
}

async function main() {
  try {
    const startTime = Date.now();
    checkWorkingDirectory();
    const newVersion = await determineNewVersion();
    generateChangelog(newVersion);
    updatePackageVersion(newVersion);
    buildProject();
    runTests();
    if (isDryRun) {
      console.log(chalk.yellow('\n🏃 预演完成'));
      return;
    }
    commitAndTag(newVersion);
    publishToNpm();
    pushToRemote(newVersion);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(chalk.green(`\n✅ 已发布 ${packageJson.name}@${newVersion} (耗时 ${duration}s)`));
  } catch (error) {
    console.log(chalk.red('\n❌ 发布失败:'));
    console.log(buildCommandFailureMessage('release', error));
    process.exit(1);
  }
}

main();
