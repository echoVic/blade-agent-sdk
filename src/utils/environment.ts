import { execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

interface EnvironmentInfo {
  workingDirectory?: string;
  projectRoot?: string;
  platform: string;
  nodeVersion: string;
  currentDate: string;
  homeDirectory: string;
}

export function getEnvironmentInfo(workingDir?: string): EnvironmentInfo {
  const projectRoot = workingDir ? findProjectRoot(workingDir) : undefined;

  return {
    workingDirectory: workingDir,
    projectRoot,
    platform: `${os.platform()} (${os.arch()})`,
    nodeVersion: process.version,
    currentDate: new Date().toISOString().split('T')[0],
    homeDirectory: os.homedir(),
  };
}

export function getEnvironmentContext(workingDir?: string): string {
  const env = getEnvironmentInfo(workingDir);
  const workingDirectorySection = env.workingDirectory
    ? `## Working Directory
**Current**: \`${env.workingDirectory}\`
**Project Root**: \`${env.projectRoot}\`

`
    : '';
  const fileGuidance = env.workingDirectory
    ? `## File Path Guidelines
When using file tools (read, write, edit), provide **absolute paths**:
- ✅ Correct: \`${env.workingDirectory}/package.json\`
- ✅ Correct: \`${env.workingDirectory}/src/index.ts\`
- ❌ Incorrect: \`/package.json\` (root directory)
- ❌ Incorrect: \`package.json\` (relative path without context)

**Always use** \`${env.workingDirectory}/\` as the base for file paths.`
    : `## File Path Guidelines
When using file tools (read, write, edit), provide **absolute paths** anchored to the active filesystem context.`;

  return `# Environment Context

${workingDirectorySection}## System Information

- **Platform**: ${env.platform}
- **Node.js**: ${env.nodeVersion}
- **Date**: ${env.currentDate}

${fileGuidance}`;
}

function findProjectRoot(startDir: string): string {
  let currentDir = startDir;

  while (currentDir !== path.dirname(currentDir)) {
    if (existsSync(path.join(currentDir, '.git'))) {
      return currentDir;
    }
    if (existsSync(path.join(currentDir, 'package.json'))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }

  return startDir;
}

function existsSync(filePath: string): boolean {
  try {
    execSync(`test -e "${filePath}"`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}


