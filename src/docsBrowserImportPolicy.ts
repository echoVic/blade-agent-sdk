import { readFileSync } from 'node:fs';

export interface BrowserClientRootSdkImportViolation {
  file: string;
  line: number;
  section: string;
  specifier: string;
}

const browserClientHeadingPattern =
  /\b(browser|client)\b|客户端|浏览器|'use client'|"use client"/i;
const bannedSdkBrowserSpecifiers = new Set([
  '@blade-ai/agent-sdk',
  '@blade-ai/agent-sdk/server',
  '@blade-ai/agent-sdk/session',
  '@blade-ai/agent-sdk/session/internal',
  '@blade-ai/agent-sdk/local',
]);
const importSpecifierPattern =
  /(?:from\s+|import\s*\(\s*)['"](@blade-ai\/agent-sdk(?:\/[^'"]*)?)['"]/g;

function parseHeading(line: string): string | undefined {
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  return match?.[2];
}

export function findBrowserClientRootSdkImportViolations(
  files: string[],
): BrowserClientRootSdkImportViolation[] {
  const violations: BrowserClientRootSdkImportViolation[] = [];

  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    let currentSection = '';
    let isClientSection = false;
    let inCodeFence = false;

    lines.forEach((line, index) => {
      const heading = parseHeading(line);
      if (heading) {
        currentSection = heading;
        isClientSection = browserClientHeadingPattern.test(heading);
      }

      if (/^```/.test(line.trim())) {
        inCodeFence = !inCodeFence;
        return;
      }

      if (!inCodeFence || !isClientSection) {
        return;
      }

      for (const match of line.matchAll(importSpecifierPattern)) {
        const specifier = match[1];
        if (specifier && bannedSdkBrowserSpecifiers.has(specifier)) {
          violations.push({
            file,
            line: index + 1,
            section: currentSection,
            specifier,
          });
        }
      }
    });
  }

  return violations;
}
