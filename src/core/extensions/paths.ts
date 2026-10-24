/** Where Claude Code keeps extensions for each scope. Computed at call time (tests redirect HOME / CLAUDE_CONFIG_DIR). */
import { join, resolve } from 'node:path'
import type { ExtensionKind, Scope } from '@shared/types'
import { claudeConfigDir, claudeUserSettingsPath } from '../platform/paths'

/** Kinds that are plain files/folders inside a .claude directory. */
export type FileKind = 'skill' | 'agent' | 'command' | 'output-style'
/** Kinds that live inside a settings.json file. */
export type SettingsKind = 'hook' | 'statusline'

export const FILE_KIND_DIRS: Record<FileKind, string> = {
  skill: 'skills',
  agent: 'agents',
  command: 'commands',
  'output-style': 'output-styles'
}

export function isFileKind(kind: ExtensionKind): kind is FileKind {
  return kind === 'skill' || kind === 'agent' || kind === 'command' || kind === 'output-style'
}

export function isSettingsKind(kind: ExtensionKind): kind is SettingsKind {
  return kind === 'hook' || kind === 'statusline'
}

/** Folder-based extensions have no "local" flavour: local is treated like project. */
export function fileScope(scope: Scope | undefined): 'user' | 'project' {
  return scope === 'project' || scope === 'local' ? 'project' : 'user'
}

/** ~/.claude (or $CLAUDE_CONFIG_DIR) for user scope, <project>/.claude otherwise. */
export function claudeBase(scope: 'user' | 'project', projectPath?: string): string {
  if (scope === 'user' || !projectPath) return claudeConfigDir()
  return join(resolve(projectPath), '.claude')
}

/** Directory holding one kind of file extension for a scope, e.g. ~/.claude/agents. */
export function kindDir(kind: FileKind, scope: 'user' | 'project', projectPath?: string): string {
  return join(claudeBase(scope, projectPath), FILE_KIND_DIRS[kind])
}

/** settings.json for user, .claude/settings.json for project, .claude/settings.local.json for local. */
export function settingsPathFor(scope: Scope, projectPath?: string): string {
  if (scope === 'user' || !projectPath) return claudeUserSettingsPath()
  return join(resolve(projectPath), '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json')
}

/** Claude Code's plugins root (~/.claude/plugins, or $CLAUDE_CODE_PLUGIN_CACHE_DIR). */
export function pluginsDir(): string {
  const override = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  return override ? resolve(override) : join(claudeConfigDir(), 'plugins')
}

export function installedPluginsPath(): string {
  return join(pluginsDir(), 'installed_plugins.json')
}

export function knownMarketplacesPath(): string {
  return join(pluginsDir(), 'known_marketplaces.json')
}

/** Claude Code's internal catalog cache (official marketplace + install counts). Read-only, best effort. */
export function pluginCatalogCachePath(): string {
  return join(pluginsDir(), 'plugin-catalog-cache.json')
}

/** Settings files Claude Code reads for a project (shared + personal). */
export function projectSettingsPaths(projectPath: string): Array<{ scope: Scope; path: string }> {
  return [
    { scope: 'project', path: settingsPathFor('project', projectPath) },
    { scope: 'local', path: settingsPathFor('local', projectPath) }
  ]
}
