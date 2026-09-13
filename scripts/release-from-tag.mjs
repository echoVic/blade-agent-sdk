import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const changelog = require('./bilingual-changelog.cjs');

const cwd = resolve(import.meta.dirname, '..');
const RELEASE_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_COMMIT_PREFIX = 'chore(release): ';
/** Registry used for the "already published?" check (npm's own override wins). */
const REGISTRY_URL = (process.env.npm_config_registry ?? 'https://registry.npmjs.org')
  .replace(/\/+$/, '');
const COMMIT_IDENTITY = [
  '-c',
  'user.name=github-actions[bot]',
  '-c',
  'user.email=41898282+github-actions[bot]@users.noreply.github.com',
];

/**
 * Parse a release tag. The tag is the single source of truth for the version:
 * nothing here derives a bump from commit types.
 */
export function parseReleaseTag(tag) {
  const match = RELEASE_TAG_PATTERN.exec(String(tag ?? '').trim());
  if (!match) {
    throw new Error(
      `Release tag must look like v<major>.<minor>.<patch>; received "${tag}"`,
    );
  }
  const parts = match.slice(1).map((value) => Number(value));
  return { version: parts.join('.'), parts };
}

/** Compare two release versions without the `v` prefix. */
export function compareVersions(left, right) {
  const leftParts = parseReleaseTag(`v${left}`).parts;
  const rightParts = parseReleaseTag(`v${right}`).parts;
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }
  return 0;
}

/** The tag must move the version forward; re-releasing the same version is not allowed. */
export function assertVersionAdvance(current, next) {
  if (compareVersions(next, current) <= 0) {
    throw new Error(
      `Release tag v${next} must be greater than the current package version ${current}`,
    );
  }
}

function git(args, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', ...options }).trim();
}

function log(message) {
  process.stdout.write(`[release] ${message}\n`);
}

function run(command, args) {
  log(`${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function readPackageJson() {
  return JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
}

function writePackageVersion(version) {
  const file = join(cwd, 'package.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest.version === version) {
    return;
  }
  const previous = manifest.version;
  manifest.version = version;
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`package version ${previous} -> ${version}`);
}

async function isPublished(name, version) {
  const response = await fetch(
    `${REGISTRY_URL}/${encodeURIComponent(name)}/${version}`,
    { headers: { accept: 'application/json' } },
  );
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(`npm registry lookup for ${name}@${version} failed: ${response.status}`);
  }
  return true;
}

function fetchMain() {
  git(['fetch', '--quiet', 'origin', 'main']);
  return 'FETCH_HEAD';
}

/** Refuse to publish a tag that main does not contain. */
function assertTagIsOnMain(tag) {
  const main = fetchMain();
  let commit;
  try {
    commit = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new Error(`Tag ${tag} does not exist; create and push it before releasing`);
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, main], { cwd });
  } catch {
    throw new Error(`${tag} is not contained in origin/main; refusing to publish it`);
  }
  return commit;
}

/** Whether main already carries the release metadata for a version. */
function mainRecordsVersion(version) {
  const main = fetchMain();
  try {
    return git(['show', `${main}:${changelog.CHANGELOGS.en.file}`]).includes(`## [${version}]`);
  } catch {
    return false;
  }
}

async function publishPackage({ name, version, dryRun }) {
  const published = await isPublished(name, version);
  if (published) {
    log(`${name}@${version} is already published; skipping npm publish`);
    return;
  }
  if (dryRun) {
    log(`would set package.json to ${version} and publish ${name}@${version}`);
    return;
  }
  writePackageVersion(version);
  run('npm', ['publish', '--access', 'public', '--provenance']);
}

/**
 * Record the release on main: version, both changelogs, and the consumed
 * fragments. The tagged tree is what npm received, so this is bookkeeping only.
 */
function writeReleaseMetadata({ version, date, fragments, dryRun }) {
  fetchMain();
  if (dryRun) {
    log(
      `would record ${version} on main (package.json, both changelogs, `
      + `${fragments.length} fragment(s) removed, one commit)`,
    );
    return false;
  }
  git(['checkout', '--quiet', '--force', '-B', 'release-metadata', 'FETCH_HEAD']);
  log(`recording metadata on main at ${git(['rev-parse', '--short', 'HEAD'])}`);

  if (changelog.changelogHasVersion(cwd, version)) {
    log(`main already records ${version}; nothing to commit`);
    return false;
  }

  writePackageVersion(version);
  for (const locale of Object.keys(changelog.CHANGELOGS)) {
    changelog.prependRelease(cwd, locale, changelog.renderRelease(version, date, locale, fragments));
  }
  changelog.removeConsumedFragments(cwd, fragments);
  log(`recorded ${version} in both changelogs and removed ${fragments.length} fragment(s)`);

  git(['add', '--all']);
  git([...COMMIT_IDENTITY, 'commit', '--message', `${RELEASE_COMMIT_PREFIX}${version} [skip ci]`]);
  git(['push', 'origin', 'HEAD:main']);
  return true;
}

function writeGithubRelease({ tag, version, notes, dryRun }) {
  try {
    execFileSync('gh', ['release', 'view', tag], { cwd, stdio: 'ignore' });
    log(`GitHub release ${tag} already exists`);
    return;
  } catch {
    // No release for this tag yet.
  }
  if (notes === undefined) {
    log(`changelog fragments are no longer available; create the GitHub release ${tag} manually`);
    return;
  }
  if (dryRun) {
    log(`would create GitHub release ${tag}`);
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), 'blade-release-'));
  const notesFile = join(directory, 'notes.md');
  writeFileSync(notesFile, notes);
  run('gh', ['release', 'create', tag, '--title', `v${version}`, '--notes-file', notesFile, '--verify-tag']);
}

/** Notes for a re-run, where the consumed fragments may already be gone. */
function tryRenderNotes(version, date) {
  try {
    return changelog.renderBilingualNotes(version, date, changelog.readReleaseFragments(cwd));
  } catch {
    return undefined;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const tagIndex = args.indexOf('--tag');
  const tag = (tagIndex === -1 ? process.env.GITHUB_REF_NAME : args[tagIndex + 1])?.trim();
  const { version } = parseReleaseTag(tag);
  const manifest = readPackageJson();
  log(`release ${tag} (version ${version})${dryRun ? ' [dry run]' : ''}`);

  assertTagIsOnMain(tag);
  const current = manifest.version;
  if (version !== current) {
    assertVersionAdvance(current, version);
  }

  const date = new Date().toISOString().slice(0, 10);

  // A re-run after a partial failure must be a no-op, not a second publish.
  const alreadyPublished = await isPublished(manifest.name, version);
  if (alreadyPublished && mainRecordsVersion(version)) {
    log(`${manifest.name}@${version} is already released; nothing to publish`);
    writeGithubRelease({ tag, version, notes: tryRenderNotes(version, date), dryRun });
    return;
  }

  const fragments = changelog.readReleaseFragments(cwd);
  const notes = changelog.renderBilingualNotes(version, date, fragments);

  await publishPackage({ name: manifest.name, version, dryRun });
  writeReleaseMetadata({ version, date, fragments, dryRun });
  writeGithubRelease({ tag, version, notes, dryRun });
  log(`released ${manifest.name}@${version}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
