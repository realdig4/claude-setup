/** MCP servers: every enabled local (stdio) server's start command can be found on this computer. */
import { basename, extname, isAbsolute } from 'node:path'
import type { DoctorCheck, InstalledServer, RuntimeName, StdioServerConfig, TargetId } from '@shared/types'
import { pathExists } from '../../fs/json'
import { which } from '../../platform/exec'
import { installFix, type CheckGroup, type RunContext } from '../context'

const CATEGORY = 'mcp' as const

const TARGET_LABELS: Record<TargetId, string> = {
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  vscode: 'VS Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf'
}

const HINTS: Array<{ re: RegExp; runtime?: RuntimeName; label: string; hint: string }> = [
  { re: /^(npx|npm|node|pnpm|pnpx|yarn)$/i, runtime: 'node', label: 'Node.js', hint: 'Install Node.js 20 or newer (it includes npx).' },
  { re: /^(uvx|uv)$/i, runtime: 'uv', label: 'uv', hint: 'Install uv (it includes uvx).' },
  { re: /^docker$/i, runtime: 'docker', label: 'Docker Desktop', hint: 'Install Docker Desktop and start it.' },
  { re: /^(python3?|py|pip3?)$/i, runtime: 'python', label: 'Python', hint: 'Install Python 3.' },
  { re: /^(bun|bunx)$/i, label: 'Bun', hint: 'Install Bun (bun.sh).' },
  { re: /^deno$/i, label: 'Deno', hint: 'Install Deno (deno.com).' }
]

/** The program that actually starts the server (unwraps Windows `cmd /c <program>`). */
export function launcherOf(config: StdioServerConfig): string {
  const cmd = config.command.trim()
  const args = config.args ?? []
  if (/^cmd(\.exe)?$/i.test(basename(cmd)) && args[0]?.toLowerCase() === '/c' && args[1]) return args[1].trim()
  return cmd
}

function programKey(cmd: string): string {
  const name = basename(cmd)
  return (extname(name) ? name.slice(0, -extname(name).length) : name).toLowerCase()
}

async function commandExists(cmd: string): Promise<boolean> {
  if (isAbsolute(cmd)) return pathExists(cmd)
  if (cmd.includes('/') || cmd.includes('\\')) return true // relative to the server's working folder; can't check
  return (await which(cmd)) !== null
}

function serverLabel(s: InstalledServer): string {
  return `${s.name} (${TARGET_LABELS[s.target.target] ?? s.target.target})`
}

function commandsOk(detail: string): DoctorCheck[] {
  return [{ id: 'mcp:commands', category: CATEGORY, title: 'MCP server commands', status: 'ok', detail }]
}

async function missingCommandChecks(rc: RunContext, servers: InstalledServer[]): Promise<DoctorCheck[]> {
  const byCommand = new Map<string, { cmd: string; servers: string[] }>()
  for (const s of servers) {
    if (!s.enabled || s.config.type !== 'stdio' || !s.config.command?.trim()) continue
    const cmd = launcherOf(s.config)
    const entry = byCommand.get(cmd) ?? { cmd, servers: [] }
    entry.servers.push(serverLabel(s))
    byCommand.set(cmd, entry)
  }
  if (!byCommand.size) return commandsOk('No local MCP servers are installed yet.')

  const missing: Array<{ cmd: string; servers: string[] }> = []
  await Promise.all(
    [...byCommand.values()].map(async (entry) => {
      if (!(await commandExists(entry.cmd))) missing.push(entry)
    })
  )
  if (!missing.length) {
    const count = [...byCommand.values()].reduce((n, e) => n + e.servers.length, 0)
    return commandsOk(`All ${count} local server${count === 1 ? '' : 's'} can find their start command.`)
  }

  const runtimes = await rc.runtimes().catch(() => [])
  return missing
    .sort((a, b) => a.cmd.localeCompare(b.cmd))
    .map((entry): DoctorCheck => {
      const key = programKey(entry.cmd)
      const known = HINTS.find((h) => h.re.test(key))
      const info = known?.runtime ? runtimes.find((r) => r.id === known.runtime) : undefined
      const fix = known?.runtime ? installFix(info, known.runtime, known.label) : undefined
      const hint = known?.hint ?? 'Check the command in the server settings, or reinstall the server.'
      return {
        id: `mcp:command:${key}`,
        category: CATEGORY,
        title: `"${basename(entry.cmd)}" not found`,
        status: 'warn',
        detail: `${entry.servers.join(', ')} can't start because "${entry.cmd}" isn't installed or isn't on the PATH. ${hint}`,
        ...(fix ? { fix } : {})
      }
    })
}

export const mcpChecks: CheckGroup = {
  id: 'mcp',
  category: CATEGORY,
  title: 'MCP servers',
  timeoutMs: 30_000,
  async run(rc) {
    const servers = await rc.servers()
    return missingCommandChecks(rc, servers)
  }
}
