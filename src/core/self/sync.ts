/**
 * Keep existing registrations of Claude Setup's own MCP server pointing at a working copy.
 * When the app is moved or reinstalled elsewhere, entries written earlier reference an executable
 * that no longer exists; the GUI calls this at startup to re-point them at the running copy.
 */
import { stat } from 'node:fs/promises'
import type { ServersApi } from '@shared/api'
import type { StdioServerConfig, TargetChangeResult } from '@shared/types'
import type { CoreContext } from '../context'
import { ALL_TARGETS, SELF_SERVER_NAME, sameLaunch } from './launch'

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Re-point registrations whose executable is missing. Only touches stdio entries named
 * 'claude-setup' that launch an mcp.js script (i.e. clearly ours). Returns the changes made.
 */
export async function refreshStaleRegistrations(ctx: CoreContext, servers: ServersApi): Promise<TargetChangeResult[]> {
  const config: StdioServerConfig | undefined = ctx.options.selfMcpConfig
  if (!config) return []
  const changes: TargetChangeResult[] = []
  for (const target of ALL_TARGETS) {
    let entries
    try {
      entries = (await servers.list({ target })).filter((s) => s.name === SELF_SERVER_NAME && s.target.target === target)
    } catch {
      continue
    }
    for (const entry of entries) {
      const current = entry.config
      if (current.type !== 'stdio') continue
      if (!/mcp\.js$/i.test(current.args?.[0] ?? '')) continue
      if (sameLaunch(current, config)) continue
      if (await exists(current.command)) continue
      try {
        const result = await servers.update(SELF_SERVER_NAME, entry.target, config)
        changes.push(result)
        ctx.log.info('self', `Updated the Claude Setup entry in ${entry.configPath}: ${result.message}`)
      } catch (err) {
        ctx.log.warn('self', `Could not update the Claude Setup entry in ${entry.configPath}: ${(err as Error).message}`)
      }
    }
  }
  return changes
}
