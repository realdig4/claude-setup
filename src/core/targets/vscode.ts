/**
 * VS Code's own MCP support (GitHub Copilot agent mode) — not the Claude Code extension, which uses Claude Code's
 * servers. mcp.json is JSONC with top-level "servers" (and "inputs", which is preserved untouched):
 *   user:    <VS Code user dir>/mcp.json of the default profile (+ VS Code Insiders when it is installed)
 *   project: <project>/.vscode/mcp.json
 * Entries: {type:'stdio', command, args, env?, cwd?} or {type:'http'|'sse', url, headers?}. VS Code reloads the
 * file automatically.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ServerConfig, TargetInfo } from '@shared/types'
import type { CoreContext } from '../context'
import { isPlainObject, pathExists } from '../fs/json'
import { vscodeUserDir } from '../platform/paths'
import type { NormalizedRef, TargetAdapter } from './adapter'
import { parseRemoteEntry, parseStdioEntry, stdioNative } from './entries'
import { createFileAdapter, type Location } from './fileAdapter'
import { isRemoteConfig } from './validate'

export function vscodeToNative(config: ServerConfig): Record<string, unknown> {
  if (isRemoteConfig(config)) {
    const out: Record<string, unknown> = { type: config.type, url: config.url }
    if (config.headers && Object.keys(config.headers).length) out.headers = { ...config.headers }
    return out
  }
  return stdioNative(config, { withType: true, withCwd: true })
}

export function vscodeFromNative(entry: unknown): ServerConfig | null {
  if (!isPlainObject(entry)) return null
  const type = typeof entry.type === 'string' ? entry.type.toLowerCase() : undefined
  if (type === 'http' || type === 'sse' || type === 'streamable-http') return parseRemoteEntry(entry)
  if (!type && typeof entry.url === 'string') return parseRemoteEntry(entry)
  return parseStdioEntry(entry)
}

async function locations(ref: NormalizedRef): Promise<Location[]> {
  if (ref.scope === 'project' && ref.projectPath) {
    return [{ file: join(ref.projectPath, '.vscode', 'mcp.json'), format: 'jsonc', mapPaths: [['servers']] }]
  }
  const stable = vscodeUserDir('Code')
  const insiders = vscodeUserDir('Code - Insiders')
  const [hasStable, hasInsiders] = await Promise.all([pathExists(stable), pathExists(insiders)])
  const loc = (dir: string): Location => ({ file: join(dir, 'mcp.json'), format: 'jsonc', mapPaths: [['servers']] })
  // Only VS Code Insiders installed: use it alone instead of creating a settings folder for stable VS Code.
  if (!hasStable && hasInsiders) return [loc(insiders)]
  return hasInsiders ? [loc(stable), loc(insiders)] : [loc(stable)]
}

const DESCRIPTION = "VS Code's built-in MCP support (GitHub Copilot agent mode)."

/** The VS Code (native MCP) TargetAdapter. */
export function createVsCodeAdapter(ctx: CoreContext): TargetAdapter {
  return createFileAdapter(ctx, {
    id: 'vscode',
    label: 'VS Code',
    description: DESCRIPTION,
    primary: false,
    supportsRemote: true,
    locations,
    toNative: vscodeToNative,
    fromNative: vscodeFromNative,
    supports: () => ({ ok: true }),
    invalidFileMessage: (file, error) =>
      `VS Code's MCP settings file (${file}) can't be read: ${error} Nothing was changed. Fix the file in VS Code or restore a backup.`,
    addedHint: () => 'VS Code picks up the change automatically.',
    snippetWrapper: (_ref, name, native) => ({ servers: { [name]: native } }),
    async info({ summarize }): Promise<TargetInfo> {
      const userDir = vscodeUserDir('Code')
      const [stable, insiders, summary] = await Promise.all([
        pathExists(userDir),
        pathExists(vscodeUserDir('Code - Insiders')),
        summarize({ target: 'vscode', scope: 'user' })
      ])
      const notes = [
        "This is VS Code's own MCP support (Copilot agent mode). The Claude Code extension for VS Code uses Claude Code's servers instead."
      ]
      if (insiders && stable) notes.push('VS Code Insiders is installed too, so its mcp.json is kept in sync.')
      else if (insiders) notes.push('Servers are added to VS Code Insiders.')
      try {
        if ((await readdir(join(userDir, 'profiles'))).length) {
          notes.push('Servers are added to the Default profile. Other VS Code profiles have their own MCP settings.')
        }
      } catch {
        // no extra profiles
      }
      if (!summary.configValid) notes.push(`The MCP settings file can't be read (${summary.configError}).`)
      const info: TargetInfo = {
        id: 'vscode',
        label: 'VS Code',
        description: DESCRIPTION,
        installed: stable || insiders,
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
