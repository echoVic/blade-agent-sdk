export const allowedPublicExportConditions = new Set(['types', 'browser', 'import']);

function isObjectRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasParentDirectorySegment(subpath) {
  return subpath.split('/').includes('..');
}

export function verifyExportSubpathShape({ prefix, subpath }) {
  if (subpath !== '.' && !subpath.startsWith('./')) {
    return `${prefix} export subpath "${subpath}" must be "." or start with "./"`;
  }
  if (hasParentDirectorySegment(subpath)) {
    return `${prefix} export subpath "${subpath}" must not contain parent directory segments`;
  }
  return null;
}

export function getManifestRootExportConditions(exportsMap) {
  if (!isObjectRecord(exportsMap)) {
    return null;
  }
  const rootExport = exportsMap['.'];
  if (!isObjectRecord(rootExport)) {
    return null;
  }
  return rootExport;
}

export function isExactPackageJsonManifestExport(exportName, exportValue) {
  return (
    exportName === './package.json' &&
    isObjectRecord(exportValue) &&
    Object.keys(exportValue).length === 1 &&
    exportValue.default === './package.json'
  );
}

export function isTypesConditionFirst(exportValue) {
  return Object.keys(exportValue).at(0) === 'types';
}

export function isBrowserConditionBeforeImport(exportValue) {
  const conditions = Object.keys(exportValue);
  const browserIndex = conditions.indexOf('browser');
  const importIndex = conditions.indexOf('import');
  return browserIndex === -1 || importIndex === -1 || browserIndex < importIndex;
}
