/** Claude Desktop: installed, config readable, duplicate configs, broken server entries, policies, MCP failures. */
import type { DoctorCheck, TargetInfo } from '@shared/types'
import { isPlainObject, readJson } from '../../fs/json'
import { desktopLogDirs, resolveDesktopConfig } from '../../targets/desktopPaths'
import { desktopEntryProblems, invalidDesktopEntries } from '../../targets/validate'
import { guard, type CheckGroup, type RunContext } from '../context'
import { recentMcpFailures } from '../desktopLogs'
import { policyIsOff, readDesktopPolicies } from '../policies'

const CATEGORY = 'claude-desktop' as const
const DOCS = 'https://modelcontextprotocol.io/docs/develop/connect-local-servers'

const TITLES = {
  installed: 'Claude Desktop',
  config: 'Claude Desktop settings file',
  drift: 'Duplicate Claude Desktop settings files',
  entries: 'Claude Desktop server entries',
  policies: 'Claude Desktop policies',
  failures: 'Claude Desktop server connections'
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

function configCheck(info: TargetInfo): DoctorCheck {
  const base = { id: 'desktop:config', category: CATEGORY, title: TITLES.config }
  if (!info.configPath) return { ...base, status: 'warn', detail: "Claude Setup couldn't work out where Claude Desktop keeps its settings file." }
  if (!info.configExists) {
    return { ...base, status: 'ok', detail: `No settings file yet — it's created when you add the first server (${info.configPath}).` }
  }
  if (!info.configValid) {
    const why = info.configError ? ` (${info.configError})` : ''
    return {
      ...base,
      status: 'error',
      detail:
        `Claude Desktop can't read ${info.configPath}${why}. It then starts without any MCP servers and won't save settings. ` +
        'Fix the file or restore a backup from Backups.',
      docsUrl: DOCS
    }
  }
  return { ...base, status: 'ok', detail: `${info.configPath} — ${info.serverCount} ${plural(info.serverCount, 'server', 'servers')}.` }
}

async function driftCheck(rc: RunContext, info: TargetInfo): Promise<DoctorCheck | null> {
  if (rc.os !== 'win32') return null
  const loc = await resolveDesktopConfig()
  const base = { id: 'desktop:config-drift', category: CATEGORY, title: TITLES.drift }
  const inUse = info.configPath ?? loc.configPath
  const others = loc.otherCopies.filter((p) => p.toLowerCase() !== inUse.toLowerCase())
  if (!others.length) return { ...base, status: 'ok', detail: 'Only one Claude Desktop settings file exists.' }
  return {
    ...base,
    status: 'warn',
    detail:
      `Claude Desktop reads only ${inUse}. ${plural(others.length, 'This other copy is', 'These other copies are')} ignored, ` +
      `so servers added there won't appear: ${others.join('; ')}. Add servers through Claude Setup (it always writes the file Desktop reads).`
  }
}

function entryReason(name: string, entry: unknown): string {
  const remote = isPlainObject(entry) && typeof entry.url === 'string' && typeof entry.command !== 'string'
  const problems = remote ? ['remote servers (url) need a bridge in Claude Desktop'] : desktopEntryProblems(entry)
  const nameProblem = /[\\/]/.test(name) ? ['the name contains / or \\'] : []
  return `${name}: ${[...nameProblem, ...problems].join(', ') || 'invalid name'}`
}

async function entriesCheck(info: TargetInfo): Promise<DoctorCheck | null> {
  if (!info.configPath || !info.configExists || !info.configValid) return null
  const r = await readJson<unknown>(info.configPath)
  if (r.error || !isPlainObject(r.data)) return null
  const servers = isPlainObject(r.data.mcpServers) ? r.data.mcpServers : {}
  const bad = invalidDesktopEntries(servers)
  const base = { id: 'desktop:invalid-entries', category: CATEGORY, title: TITLES.entries }
  if (!bad.length) return { ...base, status: 'ok', detail: 'Every server entry has the format Claude Desktop expects.' }
  const reasons = bad.map((name) => entryReason(name, servers[name]))
  return {
    ...base,
    status: 'error',
    detail:
      `Claude Desktop skips ${plural(bad.length, 'this entry', 'these entries')} and shows "Some MCP servers couldn't be loaded": ` +
      `${reasons.join('; ')}. Remove them (a backup is made) and reinstall remote servers from Discover — ` +
      'Claude Setup connects them through a bridge Desktop understands.',
    fix: { id: 'remove-invalid-desktop-entries', label: 'Remove broken entries', auto: true },
    docsUrl: DOCS
  }
}

async function policyCheck(): Promise<DoctorCheck> {
  const policies = await readDesktopPolicies()
  const base = { id: 'desktop:policies', category: CATEGORY, title: TITLES.policies }
  const blocked: string[] = []
  if (policyIsOff(policies.values.isLocalDevMcpEnabled)) {
    blocked.push('local MCP servers are turned off (isLocalDevMcpEnabled), so servers in the settings file are ignored')
  }
  if (policyIsOff(policies.values.isDesktopExtensionEnabled)) {
    blocked.push('desktop extensions (.mcpb) are turned off (isDesktopExtensionEnabled)')
  }
  if (!blocked.length) {
    const detail = policies.source ? `Policies found (${policies.source}), none block MCP servers.` : 'No organization policies restrict MCP servers.'
    return { ...base, status: 'ok', detail }
  }
  const hklm = policies.source?.startsWith('HKLM') ? ' Because machine-wide (HKLM) policies exist, Desktop ignores per-user (HKCU) ones.' : ''
  return {
    ...base,
    status: 'warn',
    detail: `An organization policy (${policies.source}) applies: ${blocked.join('; ')}. Ask your IT administrator if you need these.${hklm}`
  }
}

async function failuresCheck(info: TargetInfo): Promise<DoctorCheck> {
  const failures = await recentMcpFailures(desktopLogDirs())
  const base = { id: 'desktop:mcp-errors', category: CATEGORY, title: TITLES.failures }
  if (!failures.length) return { ...base, status: 'ok', detail: "No recent connection failures in Claude Desktop's logs." }
  const names = failures.map((f) => f.name)
  const them = plural(names.length, 'it', 'them')
  return {
    ...base,
    status: 'warn',
    detail:
      `Claude Desktop recently failed to start ${plural(names.length, 'this server', 'these servers')}: ${names.join(', ')}. ` +
      `Test ${them} on the Installed page, or read the server's log (mcp-server-<name>.log in Desktop's logs folder). ` +
      'After fixing, restart Claude Desktop.',
    ...(info.running ? { fix: { id: 'restart-desktop', label: 'Restart Claude Desktop', auto: true } } : {}),
    docsUrl: 'https://modelcontextprotocol.io/legacy/tools/debugging'
  }
}

export const desktopChecks: CheckGroup = {
  id: 'desktop',
  category: CATEGORY,
  title: 'Claude Desktop',
  timeoutMs: 30_000,
  async run(rc) {
    const info = await rc.target('claude-desktop')
    const base = { id: 'desktop:installed', category: CATEGORY, title: TITLES.installed }
    if (!info?.installed) {
      const detail = info?.configError ?? "Claude Desktop isn't installed. Install it from claude.com/download to use MCP servers in the Claude app."
      return [{ ...base, status: 'info', detail, docsUrl: 'https://claude.com/download' }]
    }
    const installed: DoctorCheck = {
      ...base,
      status: 'ok',
      detail: `Installed${info.version ? ` (version ${info.version})` : ''}${info.running ? ', running' : ''}.`
    }
    const groups = await Promise.all([
      guard('desktop:config', CATEGORY, TITLES.config, async () => configCheck(info)),
      guard('desktop:config-drift', CATEGORY, TITLES.drift, () => driftCheck(rc, info)),
      guard('desktop:invalid-entries', CATEGORY, TITLES.entries, () => entriesCheck(info)),
      guard('desktop:policies', CATEGORY, TITLES.policies, () => policyCheck()),
      guard('desktop:mcp-errors', CATEGORY, TITLES.failures, () => failuresCheck(info))
    ])
    return [installed, ...groups.flat()]
  }
}
