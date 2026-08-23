export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (
      (specifier.startsWith('./') || specifier.startsWith('../'))
      && specifier.endsWith('.js')
    ) {
      const typeScriptSpecifier = `${specifier.slice(0, -3)}.ts`;
      try {
        return await nextResolve(typeScriptSpecifier, context);
      } catch {
        // Preserve the original resolution error when no TypeScript peer exists.
      }
    }
    throw error;
  }
}
