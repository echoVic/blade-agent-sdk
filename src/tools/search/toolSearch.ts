import type { Tool } from '../types/index.js';

/**
 * Normalize a search query or field value for comparison.
 */
export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Score how well a tool matches a normalized search query.
 * Returns 0 for no match, higher scores for better matches.
 */
export function scoreToolSearchMatch(tool: Tool, normalizedQuery: string): number {
  const aliases = tool.aliases ?? [];
  const longDescription = typeof tool.description === 'string'
    ? tool.description
    : [tool.description.short, tool.description.long, tool.exposure.discoveryHint]
      .filter(Boolean)
      .join(' ');

  const fields: Array<[string, number]> = [
    [tool.name, 120],
    ...aliases.map((alias) => [alias, 110] as [string, number]),
    [tool.displayName, 90],
    [tool.category ?? '', 60],
    ...tool.tags.map((tag) => [tag, 50] as [string, number]),
    [tool.exposure.discoveryHint, 45],
    [longDescription, 30],
  ];

  let bestScore = 0;
  for (const [field, baseScore] of fields) {
    const score = scoreFieldMatch(field, normalizedQuery, baseScore);
    if (score > bestScore) {
      bestScore = score;
    }
  }

  return bestScore;
}

function scoreFieldMatch(field: string | undefined, normalizedQuery: string, baseScore: number): number {
  if (!field) {
    return 0;
  }

  const normalizedField = normalizeSearchText(field);
  if (!normalizedField) {
    return 0;
  }

  if (normalizedField === normalizedQuery) {
    return baseScore + 100;
  }

  if (normalizedField.startsWith(normalizedQuery)) {
    return baseScore + 60;
  }

  if (normalizedField.includes(normalizedQuery)) {
    return baseScore + 30;
  }

  const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);
  if (queryTerms.length > 1 && queryTerms.every((term) => normalizedField.includes(term))) {
    return baseScore + 20;
  }

  return 0;
}

/**
 * Search a list of tools by query, returning matches sorted by relevance.
 */
export function searchTools(tools: Tool[], query: string): Tool[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return [];
  }

  return tools
    .map((tool) => ({
      tool,
      score: scoreToolSearchMatch(tool, normalizedQuery),
    }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
    .map(({ tool }) => tool);
}
