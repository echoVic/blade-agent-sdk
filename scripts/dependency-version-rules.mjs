const exactDependencyVersionPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isExactDependencyVersion(versionSpec) {
  return typeof versionSpec === 'string' && exactDependencyVersionPattern.test(versionSpec);
}

export function isInternalBladeDependency(dependencyName) {
  return /^@blade-ai\//.test(dependencyName);
}
