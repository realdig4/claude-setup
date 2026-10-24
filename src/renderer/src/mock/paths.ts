/** Realistic per-OS config file locations for the mock (mirrors research_desktop/research_code findings). */
import type { TargetId, TargetRef } from '@shared/types'
import { env, homePath } from './runtime'

/** Claude Desktop config (Windows MSIX installs keep it under LocalCache). */
export function desktopConfigPath(): string {
  if (env.platform === 'win32') {
    return homePath('AppData', 'Local', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json')
  }
  if (env.platform === 'darwin') return homePath('Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  return homePath('.config', 'Claude', 'claude_desktop_config.json')
}

export function vscodeUserDir(): string {
  if (env.platform === 'win32') return homePath('AppData', 'Roaming', 'Code', 'User')
  if (env.platform === 'darwin') return homePath('Library', 'Application Support', 'Code', 'User')
  return homePath('.config', 'Code', 'User')
}

/** Primary user-scope config file for a target. */
export function userConfigPath(target: TargetId): string {
  switch (target) {
    case 'claude-desktop':
      return desktopConfigPath()
    case 'claude-code':
      return homePath('.claude.json')
    case 'vscode':
      return [vscodeUserDir(), 'mcp.json'].join(env.sep)
    case 'cursor':
      return homePath('.cursor', 'mcp.json')
    case 'windsurf':
      return homePath('.codeium', 'windsurf', 'mcp_config.json')
  }
}

/** Config file for any target/scope combination. */
export function configPathFor(ref: TargetRef): string {
  if (ref.scope === 'project' && ref.projectPath) {
    if (ref.target === 'vscode') return [ref.projectPath, '.vscode', 'mcp.json'].join(env.sep)
    if (ref.target === 'cursor') return [ref.projectPath, '.cursor', 'mcp.json'].join(env.sep)
    return [ref.projectPath, '.mcp.json'].join(env.sep)
  }
  return userConfigPath(ref.target)
}

export function claudeSettingsPath(): string {
  return homePath('.claude', 'settings.json')
}

export function vscodeSettingsPath(): string {
  return [vscodeUserDir(), 'settings.json'].join(env.sep)
}

export function dataDir(): string {
  if (env.platform === 'win32') return homePath('AppData', 'Roaming', 'Claude Setup')
  if (env.platform === 'darwin') return homePath('Library', 'Application Support', 'Claude Setup')
  return homePath('.config', 'Claude Setup')
}

/** A sample project folder used for project/local scopes. */
export function sampleProject(): string {
  return homePath('Projects', 'acme-web')
}
