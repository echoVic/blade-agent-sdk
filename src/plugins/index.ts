/**
 * Blade Code Plugins System
 *
 * This module provides a plugin system for extending Blade Code with
 * custom commands, agents, skills, hooks, and MCP servers.
 *
 * @module plugins
 */

export { getPluginInstaller, PluginInstaller } from './PluginInstaller.js';
export { clearAllPluginResources, integrateAllPlugins, PluginIntegrator } from './PluginIntegrator.js';
export { getPluginRegistry, PluginRegistry } from './PluginRegistry.js';
export { PluginLoader } from './PluginLoader.js';
export { isValidPluginDir, parsePluginManifest } from './PluginManifest.js';
export { getMcpNamespacedName, getNamespacedName } from './namespacing.js';
export type {
  LoadedPlugin,
  ManifestSource,
  PluginAgent,
  PluginAuthor,
  PluginCommand,
  PluginDiscoveryError,
  PluginDiscoveryResult,
  PluginManifest,
  PluginSkill,
  PluginSource,
  PluginStatus,
} from './types.js';
