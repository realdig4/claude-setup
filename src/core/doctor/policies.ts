/**
 * Claude Desktop enterprise policies that switch off MCP features:
 * Windows HKLM/HKCU\SOFTWARE\Policies\Claude (any HKLM value makes Desktop ignore HKCU), macOS managed preferences
 * (com.anthropic.claudefordesktop), Linux /etc/claude-desktop/managed-settings.json.
 */
import { userInfo } from 'node:os'
import { isPlainObject, pathExists, readJson } from '../fs/json'
import { run } from '../platform/exec'
import { currentOS } from '../platform/paths'

export interface DesktopPolicies {
  /** Where the policies came from, e.g. "HKLM\SOFTWARE\Policies\Claude". */
  source?: string
  values: Record<string, string>
}

const POLICY_KEYS = ['HKLM\\SOFTWARE\\Policies\\Claude', 'HKCU\\SOFTWARE\\Policies\\Claude']

/** Parse `reg query` output into name → value (REG_DWORD values become decimal strings). */
export function parseRegQuery(output: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+(REG_[A-Z_]+)\s*(.*)$/.exec(line)
    if (!m) continue
    const [, name, type, raw] = m
    const value = raw.trim()
    values[name] = type === 'REG_DWORD' || type === 'REG_QWORD' ? String(Number.parseInt(value, 16)) : value
  }
  return values
}

/** True when a policy value means "off" (0, false, no). */
export function policyIsOff(value: string | undefined): boolean {
  return value !== undefined && /^(0|false|no|off)$/i.test(value.trim())
}

function flatten(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string') out[k] = v
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = String(v)
  }
  return out
}

async function windowsPolicies(): Promise<DesktopPolicies> {
  for (const key of POLICY_KEYS) {
    const r = await run('reg', ['query', key], { timeoutMs: 8000 })
    if (!r.ok) continue
    const values = parseRegQuery(r.stdout)
    if (Object.keys(values).length) return { source: key, values }
  }
  return { values: {} }
}

async function macPolicies(): Promise<DesktopPolicies> {
  let user = ''
  try {
    user = userInfo().username
  } catch {
    // no user info
  }
  const files = [
    ...(user ? [`/Library/Managed Preferences/${user}/com.anthropic.claudefordesktop.plist`] : []),
    '/Library/Managed Preferences/com.anthropic.claudefordesktop.plist'
  ]
  for (const file of files) {
    if (!(await pathExists(file))) continue
    const r = await run('plutil', ['-convert', 'json', '-o', '-', file], { timeoutMs: 8000 })
    if (!r.ok) continue
    try {
      const data: unknown = JSON.parse(r.stdout)
      if (isPlainObject(data)) return { source: file, values: flatten(data) }
    } catch {
      // not JSON
    }
  }
  return { values: {} }
}

async function linuxPolicies(): Promise<DesktopPolicies> {
  const file = '/etc/claude-desktop/managed-settings.json'
  const r = await readJson<unknown>(file)
  if (!r.exists || r.error || !isPlainObject(r.data)) return { values: {} }
  return { source: file, values: flatten(r.data) }
}

/** Read the Desktop policies that apply on this machine (empty when none). */
export async function readDesktopPolicies(): Promise<DesktopPolicies> {
  const os = currentOS()
  if (os === 'win32') return windowsPolicies()
  if (os === 'darwin') return macPolicies()
  return linuxPolicies()
}
