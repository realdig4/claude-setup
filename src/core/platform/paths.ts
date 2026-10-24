/**
 * OS-specific locations. Everything is computed at call time from
 * process.env / os.homedir() so tests can redirect HOME/USERPROFILE/APPDATA.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { OS } from '@shared/types'

export const PRODUCT_NAME = 'Claude Setup'

export function currentOS(): OS {
  return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
}

export function homeDir(): string {
  return homedir()
}

/** Windows %APPDATA%, macOS ~/Library/Application Support, Linux $XDG_CONFIG_HOME or ~/.config */
export function roamingDir(): string {
  const os = currentOS()
  if (os === 'win32') return process.env.APPDATA || join(homeDir(), 'AppData', 'Roaming')
  if (os === 'darwin') return join(homeDir(), 'Library', 'Application Support')
  return process.env.XDG_CONFIG_HOME || join(homeDir(), '.config')
}

/** Windows %LOCALAPPDATA%; elsewhere same as roamingDir(). */
export function localDir(): string {
  if (currentOS() === 'win32') return process.env.LOCALAPPDATA || join(homeDir(), 'AppData', 'Local')
  return roamingDir()
}

/** Claude Setup's own data directory. CLAUDE_SETUP_DATA_DIR overrides (tests, portable use). */
export function appDataDir(): string {
  return process.env.CLAUDE_SETUP_DATA_DIR || join(roamingDir(), PRODUCT_NAME)
}

/** ~/.claude, or $CLAUDE_CONFIG_DIR. */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homeDir(), '.claude')
}

/** ~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json. */
export function claudeJsonPath(): string {
  return process.env.CLAUDE_CONFIG_DIR ? join(resolve(process.env.CLAUDE_CONFIG_DIR), '.claude.json') : join(homeDir(), '.claude.json')
}

/** ~/.claude/settings.json (user scope settings, strict JSON). */
export function claudeUserSettingsPath(): string {
  return join(claudeConfigDir(), 'settings.json')
}

/** Enterprise managed Claude Code directory (managed-settings.json, managed-mcp.json). */
export function managedClaudeCodeDir(): string {
  const os = currentOS()
  if (os === 'win32') return 'C:\\Program Files\\ClaudeCode'
  if (os === 'darwin') return '/Library/Application Support/ClaudeCode'
  return '/etc/claude-code'
}

export type EditorVariant = 'Code' | 'Code - Insiders' | 'Cursor' | 'Windsurf' | 'VSCodium'

/** User settings directories of VS Code-family editors (…/User). May not exist. */
export function editorUserDirs(): Array<{ variant: EditorVariant; dir: string }> {
  const variants: EditorVariant[] = ['Code', 'Code - Insiders', 'Cursor', 'Windsurf', 'VSCodium']
  return variants.map((variant) => ({ variant, dir: join(roamingDir(), variant, 'User') }))
}

export function vscodeUserDir(variant: EditorVariant = 'Code'): string {
  return join(roamingDir(), variant, 'User')
}

export function expandHome(p: string): string {
  if (p === '~') return homeDir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homeDir(), p.slice(2))
  return p
}

/**
 * Key format Claude Code uses for ~/.claude.json "projects": absolute path with
 * forward slashes, drive letter case preserved (lookups are case-sensitive!).
 */
export function projectKey(projectPath: string): string {
  return resolve(projectPath).replace(/\\/g, '/')
}

/** Both drive-letter casings of a Windows project key (C:/x and c:/x). */
export function projectKeyVariants(projectPath: string): string[] {
  const key = projectKey(projectPath)
  if (/^[a-zA-Z]:\//.test(key)) {
    const upper = key[0].toUpperCase() + key.slice(1)
    const lower = key[0].toLowerCase() + key.slice(1)
    return upper === lower ? [key] : [upper, lower]
  }
  return [key]
}
