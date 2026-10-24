/**
 * Cursor: mcp.json with top-level "mcpServers".
 *   user:    ~/.cursor/mcp.json
 *   project: <project>/.cursor/mcp.json
 * Entries: {command, args, env?} for local servers, {url, headers?} for remote ones (Cursor detects HTTP vs SSE).
 * Read as JSONC so comments survive (Cursor is a VS Code fork).
 */
import { join } from 'node:path'
import type { ServerConfig, TargetInfo } from '@shared/types'
import type { CoreContext } from '../context'
import { isPlainObject, pathExists } from '../fs/json'
import { homeDir, localDir, vscodeUserDir } from '../platform/paths'
import type { NormalizedRef, TargetAdapter } from './adapter'
import { parseRemoteEntry, parseStdioEntry, stdioNative } from './entries'
import { createFileAdapter, type Location } from './fileAdapter'
import { isRemoteConfig } from './validate'

export function cursorToNative(config: ServerConfig): Record<string, unknown> {
  if (isRemoteConfig(config)) {
    const out: Record<string, unknown> = { url: config.url }
    if (config.headers && Object.keys(config.headers).length) out.headers = { ...config.headers }
    return out
  }
  return stdioNative(config)
}

export function cursorFromNative(entry: unknown): ServerConfig | null {
  if (!isPlainObject(entry)) return null
  if (typeof entry.command === 'string') return parseStdioEntry(entry)
  return parseRemoteEntry(entry, ['url', 'serverUrl'])
}

async function locations(ref: NormalizedRef): Promise<Location[]> {
  if (ref.scope === 'project' && ref.projectPath) {
    return [{ file: join(ref.projectPath, '.cursor', 'mcp.json'), format: 'jsonc', mapPaths: [['mcpServers']] }]
  }
  return [{ file: join(homeDir(), '.cursor', 'mcp.json'), format: 'jsonc', mapPaths: [['mcpServers']] }]
}

/** Cursor app or its config folder present. */
async function cursorInstalled(): Promise<boolean> {
  const candidates = [join(homeDir(), '.cursor'), vscodeUserDir('Cursor')]
  if (process.platform === 'win32') candidates.push(join(localDir(), 'Programs', 'cursor', 'Cursor.exe'))
  if (process.platform === 'darwin') candidates.push('/Applications/Cursor.app')
  for (const c of candidates) if (await pathExists(c)) return true
  return false
}

const DESCRIPTION = 'The Cursor code editor.'

/** The Cursor TargetAdapter. */
export function createCursorAdapter(ctx: CoreContext): TargetAdapter {
  return createFileAdapter(ctx, {
    id: 'cursor',
    label: 'Cursor',
    description: DESCRIPTION,
    primary: false,
    supportsRemote: true,
    locations,
    toNative: cursorToNative,
    fromNative: cursorFromNative,
    supports: (config) =>
      !isRemoteConfig(config) && config.cwd ? { ok: true, reason: "Cursor has no working-folder (cwd) setting, so it's left out." } : { ok: true },
    invalidFileMessage: (file, error) =>
      `Cursor's MCP settings file (${file}) can't be read: ${error} Nothing was changed. Fix the file or restore a backup.`,
    addedHint: () => 'Cursor picks it up automatically (check Cursor Settings → MCP if it shows as off).',
    snippetWrapper: (_ref, name, native) => ({ mcpServers: { [name]: native } }),
    async info({ summarize }): Promise<TargetInfo> {
      const [installed, summary] = await Promise.all([cursorInstalled(), summarize({ target: 'cursor', scope: 'user' })])
      const notes: string[] = []
      if (!summary.configValid) notes.push(`The MCP settings file can't be read (${summary.configError}).`)
      const info: TargetInfo = {
        id: 'cursor',
        label: 'Cursor',
        description: DESCRIPTION,
        installed,
        configPath: summary.configPath,
        configExists: summary.configExists,
        configValid: summary.configValid,
        supportsRemote: true,
        scopes: ['user', 'project'],
        serverCount: summary.serverCount,
        notes,
        primary: false
      }
      if (summary.configError) info.configError = summary.configError
      return info
    }
  })
}
