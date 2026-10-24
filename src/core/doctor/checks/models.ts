/** Models: current setup, credential conflicts, translation proxy, retiring models and other model problems. */
import type { CheckStatus, DoctorCheck } from '@shared/types'
import type { ModelInspection, ModelIssueCode } from '../../models/status'
import type { CheckGroup } from '../context'

const CATEGORY = 'models' as const
const GATEWAY_DOCS = 'https://code.claude.com/docs/en/llm-gateway'

/** Issues reported by their own dedicated checks below (or by the Claude Code / VS Code groups). */
const HANDLED: ModelIssueCode[] = ['settings-invalid', 'auth-conflict', 'proxy-down', 'proxy-token', 'shell-routing', 'vscode-invalid']

const ISSUE_INFO: Record<ModelIssueCode, { title: string; status: CheckStatus }> = {
  'settings-invalid': { title: 'Claude Code settings file', status: 'error' },
  'non-string-env': { title: 'Settings values that are ignored', status: 'warn' },
  'auth-conflict': { title: 'Claude Code credentials', status: 'error' },
  'no-credential': { title: 'API key for the custom endpoint', status: 'warn' },
  'missing-slots': { title: 'Model choices for every task', status: 'warn' },
  'proxy-down': { title: 'Translation proxy', status: 'error' },
  'proxy-token': { title: 'Translation proxy access token', status: 'warn' },
  retiring: { title: 'Retiring model', status: 'warn' },
  'base-url-v1': { title: 'Provider address', status: 'error' },
  'deprecated-var': { title: 'Outdated setting', status: 'info' },
  'gateway-var': { title: 'Undocumented setting', status: 'warn' },
  'shell-routing': { title: 'Environment variables', status: 'warn' },
  'vscode-invalid': { title: 'VS Code settings file', status: 'warn' }
}

function currentCheck(m: ModelInspection): DoctorCheck {
  const base = { id: 'models:current', category: CATEGORY, title: 'Model used by Claude Code' }
  if (m.mode === 'anthropic') return { ...base, status: 'ok', detail: 'Claude Code uses Claude with your Claude account (official setup).' }
  const model = m.model ? `${m.model} ` : ''
  const via = m.providerName ?? (m.mode === 'cloud' ? 'your cloud provider' : m.baseUrl ?? 'a custom endpoint')
  const profile = m.profile ? ` (profile "${m.profile.name}")` : ''
  return { ...base, status: 'ok', detail: `Claude Code uses ${model}via ${via}${profile}.`, ...(m.mode === 'custom' ? { docsUrl: GATEWAY_DOCS } : {}) }
}

function authCheck(m: ModelInspection): DoctorCheck {
  const base = { id: 'models:auth-conflict', category: CATEGORY, title: 'Claude Code credentials' }
  const issue = m.issues.find((i) => i.code === 'auth-conflict')
  if (issue) return { ...base, status: 'error', detail: issue.message, fix: { id: 'fix-auth-conflict', label: 'Keep only one credential', auto: true } }
  const detail = m.credentials.count ? 'Exactly one credential is set.' : 'No API key is set — Claude Code uses your Claude login.'
  return { ...base, status: 'ok', detail }
}

function proxyCheck(m: ModelInspection): DoctorCheck | null {
  if (!m.usesProxy) return null
  const base = { id: 'models:proxy', category: CATEGORY, title: 'Translation proxy' }
  const down = m.issues.find((i) => i.code === 'proxy-down')
  if (down) return { ...base, status: 'error', detail: down.message, fix: { id: 'start-proxy', label: 'Start the proxy', auto: true } }
  const token = m.issues.find((i) => i.code === 'proxy-token')
  if (token) return { ...base, status: 'warn', detail: token.message }
  if (m.proxyRunning === undefined) return { ...base, status: 'warn', detail: "Claude Code uses the translation proxy, but its state couldn't be checked." }
  return { ...base, status: 'ok', detail: 'The translation proxy Claude Code uses is running.' }
}

function shellCheck(m: ModelInspection): DoctorCheck | null {
  const routing = m.issues.filter((i) => i.code === 'shell-routing')
  if (!m.shellOverrides.length && !routing.length) return null
  const base = { id: 'models:shell', category: CATEGORY, title: 'Environment variables' }
  if (routing.length) return { ...base, status: 'warn', detail: routing.map((i) => i.message).join(' ') }
  return {
    ...base,
    status: 'info',
    detail:
      `These variables are set in your environment: ${m.shellOverrides.join(', ')}. ` +
      "Claude Code's settings.json overrides the same names, except in sessions that Claude Desktop starts."
  }
}

/** One check per remaining issue (ids get -2, -3… when a code repeats). */
function otherIssueChecks(m: ModelInspection): DoctorCheck[] {
  const seen = new Map<string, number>()
  return m.issues
    .filter((i) => !HANDLED.includes(i.code))
    .map((issue) => {
      const n = (seen.get(issue.code) ?? 0) + 1
      seen.set(issue.code, n)
      const info = ISSUE_INFO[issue.code]
      return { id: `models:${issue.code}${n > 1 ? `-${n}` : ''}`, category: CATEGORY, title: info.title, status: info.status, detail: issue.message }
    })
}

export const modelChecks: CheckGroup = {
  id: 'models',
  category: CATEGORY,
  title: 'Models',
  timeoutMs: 20_000,
  async run(rc) {
    const m = await rc.models()
    if (m.settingsError) {
      const detail = "Claude Code's settings file can't be read (see Claude Code above)."
      return [{ id: 'models:current', category: CATEGORY, title: 'Model used by Claude Code', status: 'skip', detail }]
    }
    const checks: DoctorCheck[] = [currentCheck(m), authCheck(m)]
    const proxy = proxyCheck(m)
    if (proxy) checks.push(proxy)
    checks.push(...otherIssueChecks(m))
    const shell = shellCheck(m)
    if (shell) checks.push(shell)
    return checks
  }
}
