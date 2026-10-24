/**
 * Windsurf — renamed "Devin Desktop" in June 2026. Two user-level MCP files exist in the wild:
 *   classic Windsurf (Cascade):  ~/.codeium/windsurf/mcp_config.json   remote entries use "serverUrl"
 *   Devin Desktop / Devin CLI:   ~/.config/devin/mcp_config.json        remote entries use "url" + "transport"
 *                                (%APPDATA%\devin\mcp_config.json on Windows; $XDG_CONFIG_HOME honoured)
 * Both use top-level "mcpServers" and {command, args, env} for local servers. The file of the edition that is
 * installed is the primary one; when both files exist they are kept in sync.
 */
import { join } from 'node:path'
import type { ServerConfig, TargetInfo } from '@shared/types'
import type { CoreContext } from '../context'
import { isPlainObject, pathExists } from '../fs/json'
import { currentOS, homeDir, roamingDir, vscodeUserDir } from '../platform/paths'
import type { TargetAdapter } from './adapter'
import { parseRemoteEntry, parseStdioEntry, stdioNative } from './entries'
import { createFileAdapter, type Location } from './fileAdapter'
import { isRemoteConfig } from './validate'

/** ~/.codeium/windsurf/mcp_config.json */
export function windsurfClassicPath(): string {
  return join(homeDir(), '.codeium', 'windsurf', 'mcp_config.json')
}

/** Devin Desktop / Devin CLI user MCP file. */
export function devinMcpPath(): string {
  if (currentOS() === 'win32') return join(roamingDir(), 'devin', 'mcp_config.json')
  return join(process.env.XDG_CONFIG_HOME || join(homeDir(), '.config'), 'devin', 'mcp_config.json')
}

/** Classic Windsurf entry: remote servers use "serverUrl". */
export function windsurfToNative(config: ServerConfig): Record<string, unknown> {
  if (isRemoteConfig(config)) {
    const out: Record<string, unknown> = { serverUrl: config.url }
    if (config.headers && Object.keys(config.headers).length) out.headers = { ...config.headers }
    return out
  }
  return stdioNative(config)
}

/** Devin entry: remote servers use "url" + "transport" (Cascade in Devin Desktop also accepts "url"). */
export function devinToNative(config: ServerConfig): Record<string, unknown> {
  if (isRemoteConfig(config)) {
    const out: Record<string, unknown> = { url: config.url, transport: config.type }
    if (config.headers && Object.keys(config.headers).length) out.headers = { ...config.headers }
    return out
  }
  return stdioNative(config)
}

export function windsurfFromNative(entry: unknown): ServerConfig | null {
  if (!isPlainObject(entry)) return null
  if (typeof entry.command === 'string') return parseStdioEntry(entry)
  return parseRemoteEntry(entry, ['serverUrl', 'url'])
}

interface Editions {
  classic: boolean
  devin: boolean
}

async function detectEditions(): Promise<Editions> {
  const [classicDir, classicUser, classicFile, devinData, devinFile, devinExt] = await Promise.all([
    pathExists(join(homeDir(), '.codeium', 'windsurf')),
    pathExists(vscodeUserDir('Windsurf')),
    pathExists(windsurfClassicPath()),
    pathExists(join(roamingDir(), 'Devin')),
    pathExists(devinMcpPath()),
    pathExists(join(homeDir(), '.devin'))
  ])
  return { classic: classicDir || classicUser || classicFile, devin: devinData || devinFile || devinExt }
}

async function locations(): Promise<Location[]> {
  const [ed, classicFile, devinFile] = await Promise.all([detectEditions(), pathExists(windsurfClassicPath()), pathExists(devinMcpPath())])
  const classic: Location = { file: windsurfClassicPath(), format: 'jsonc', mapPaths: [['mcpServers']], toNative: windsurfToNative }
  const devin: Location = { file: devinMcpPath(), format: 'jsonc', mapPaths: [['mcpServers']], toNative: devinToNative }
  if (ed.devin) return classicFile ? [devin, classic] : [devin]
  return devinFile ? [classic, devin] : [classic]
}

const DESCRIPTION = 'Windsurf (now called Devin Desktop).'

/** The Windsurf / Devin Desktop TargetAdapter. */
export function createWindsurfAdapter(ctx: CoreContext): TargetAdapter {
  return createFileAdapter(ctx, {
    id: 'windsurf',
    label: 'Windsurf',
    description: DESCRIPTION,
    primary: false,
    supportsRemote: true,
    locations,
    toNative: windsurfToNative,
    fromNative: windsurfFromNative,
    supports: (config) =>
      !isRemoteConfig(config) && config.cwd ? { ok: true, reason: "Windsurf has no working-folder (cwd) setting, so it's left out." } : { ok: true },
    invalidFileMessage: (file, error) =>
      `Windsurf's MCP settings file (${file}) can't be read: ${error} Nothing was changed. Fix the file or restore a backup.`,
    addedHint: () => 'In Windsurf / Devin Desktop, open the MCP panel and click Refresh to load it.',
    snippetWrapper: (_ref, name, native) => ({ mcpServers: { [name]: native } }),
    async info({ summarize }): Promise<TargetInfo> {
      const [ed, locs, summary] = await Promise.all([detectEditions(), locations(), summarize({ target: 'windsurf', scope: 'user' })])
      const notes = ['Windsurf was renamed Devin Desktop in June 2026; both editions are supported.']
      if (locs.length > 1) notes.push(`Servers are kept in sync in ${locs.map((l) => l.file).join(' and ')}.`)
      if (!summary.configValid) notes.push(`The MCP settings file can't be read (${summary.configError}).`)
      const info: TargetInfo = {
        id: 'windsurf',
        label: 'Windsurf',
        description: DESCRIPTION,
        installed: ed.classic || ed.devin,
        configPath: summary.configPath,
        configExists: summary.configExists,
        configValid: summary.configValid,
        supportsRemote: true,
        scopes: ['user'],
        serverCount: summary.serverCount,
        notes,
        primary: false
      }
      if (summary.configError) info.configError = summary.configError
      return info
    }
  })
}
