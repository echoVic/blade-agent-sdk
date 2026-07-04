const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const publishablePackages = [
  'packages/ai',
  'packages/agent',
  'packages/agent-sdk',
];

const internalPackageNames = new Set([
  '@blade-ai/ai',
  '@blade-ai/agent',
  '@blade-ai/agent-sdk',
]);

function readManifest(cwd, packageDir) {
  const manifestPath = join(cwd, packageDir, 'package.json');
  return {
    manifestPath,
    manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),
  };
}

function syncDependencyBlock(dependencies, version) {
  if (!dependencies) {
    return;
  }
  for (const name of Object.keys(dependencies)) {
    if (internalPackageNames.has(name)) {
      dependencies[name] = version;
    }
  }
}

function writeManifest(manifestPath, manifest) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function syncWorkspaceVersions(context) {
  const version = context?.nextRelease?.version;
  if (!version) {
    throw new Error('sync-workspace-versions requires context.nextRelease.version');
  }

  const cwd = context.cwd || process.cwd();
  for (const packageDir of publishablePackages) {
    const { manifestPath, manifest } = readManifest(cwd, packageDir);
    manifest.version = version;
    syncDependencyBlock(manifest.dependencies, version);
    syncDependencyBlock(manifest.peerDependencies, version);
    syncDependencyBlock(manifest.optionalDependencies, version);
    writeManifest(manifestPath, manifest);
  }

  context.logger?.log?.(
    'Synchronized workspace package versions for %s',
    publishablePackages.join(', '),
  );
}

module.exports = {
  prepare: (_, context) => syncWorkspaceVersions(context),
  syncWorkspaceVersions,
};
