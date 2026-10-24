/**
 * Turn a catalog InstallOption + the user's InstallValues into a concrete ServerConfig.
 * This is the single place that understands the placeholder conventions used by the registry:
 *
 *   {{arg:NAME}}  ArgSpec value. An args element holding a repeatable arg is emitted once per value
 *                 (repeating a directly preceding "--NAME" flag). An element for an optional arg left
 *                 empty is dropped together with a directly preceding "--NAME" / "-NAME" flag.
 *   {{NAME}}      EnvVarSpec value (inside args or the URL).
 *   header.template  e.g. "Bearer {{value}}": the user types only the token.
 *
 * Env / header specs with a `default` are written with that default when the user leaves them empty.
 * Target-specific adjustments (Windows `cmd /c npx`, Claude Desktop's stdio-only bridge for remotes)
 * are NOT done here — that is the job of the target adapters.
 */
import type { InstallOption, InstallValues, ServerConfig } from '@shared/types'
import type { HeaderSpec } from './types'

export interface LaunchResult {
  ok: boolean
  config?: ServerConfig
  /** Names of required values that are missing (env var / header / argument names). */
  missing: string[]
  /** Friendly problems (e.g. option needs manual setup). */
  warnings: string[]
}

const ARG_RE = /\{\{arg:([A-Za-z0-9_.-]+)\}\}/g
const ENV_RE = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g

function sanitize(name: string): string {
  return name.replace(/^-+/, '').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '')
}

function isFlagFor(element: string | undefined, argName: string): boolean {
  return !!element && /^-{1,2}[^-]/.test(element) && !element.includes('{{') && sanitize(element).toLowerCase() === argName.toLowerCase()
}

/** Expand {{NAME}} env placeholders. */
function expandEnv(text: string, env: Record<string, string>): string {
  return text.replace(ENV_RE, (_w, name: string) => env[name] ?? '')
}

/** Expand an args template (see module docs). */
export function expandArgs(template: string[], argValues: Record<string, string[]>, env: Record<string, string>): string[] {
  const out: string[] = []
  for (const element of template) {
    const names = [...new Set([...element.matchAll(ARG_RE)].map((m) => m[1]))]
    if (!names.length) {
      out.push(expandEnv(element, env))
      continue
    }
    const primary = names[0]
    const values = argValues[primary] ?? []
    const others = (text: string) => text.replace(ARG_RE, (_w, n: string) => argValues[n]?.[0] ?? '')
    if (!values.length) {
      if (isFlagFor(out[out.length - 1], primary)) out.pop()
      continue
    }
    const flag = isFlagFor(out[out.length - 1], primary) ? out[out.length - 1] : undefined
    values.forEach((value, i) => {
      if (i > 0 && flag) out.push(flag)
      out.push(expandEnv(others(element.split(`{{arg:${primary}}}`).join(value)), env))
    })
  }
  return out
}

function nonEmpty(value: string | undefined): string | undefined {
  const v = value?.trim()
  return v ? v : undefined
}

/** Apply a header template ("Bearer {{value}}") unless the user already typed the full value. */
export function applyHeaderTemplate(spec: HeaderSpec, value: string): string {
  if (!spec.template || !spec.template.includes('{{value}}')) return value
  const [prefix] = spec.template.split('{{value}}')
  if (prefix && value.toLowerCase().startsWith(prefix.toLowerCase())) return value
  return spec.template.split('{{value}}').join(value)
}

/** Build the ServerConfig for an install option. Never throws for missing values; reports them. */
export function buildServerConfig(option: InstallOption, values: InstallValues = {}): LaunchResult {
  const missing: string[] = []
  const warnings: string[] = []

  const env: Record<string, string> = {}
  for (const spec of option.env) {
    const v = nonEmpty(values.env?.[spec.name]) ?? nonEmpty(spec.default)
    if (v !== undefined) env[spec.name] = v
    else if (spec.required) missing.push(spec.name)
  }

  const argValues: Record<string, string[]> = {}
  for (const spec of option.argsSpec ?? []) {
    const raw = values.args?.[spec.name]
    let list = (Array.isArray(raw) ? raw : raw !== undefined ? [raw] : []).map((x) => String(x).trim()).filter(Boolean)
    if (!spec.repeatable) list = list.slice(0, 1)
    if (!list.length && nonEmpty(spec.default)) list = [spec.default!.trim()]
    if (list.length) argValues[spec.name] = list
    else if (spec.required) missing.push(spec.name)
  }

  if (option.kind === 'remote' || option.transport === 'http' || option.transport === 'sse') {
    if (!option.url) return { ok: false, missing, warnings: ['This option has no server address.'] }
    const url = expandEnv(option.url.replace(ARG_RE, (_w, n: string) => argValues[n]?.[0] ?? ''), env)
    const headers: Record<string, string> = {}
    for (const spec of (option.headers ?? []) as HeaderSpec[]) {
      const typed = nonEmpty(values.headers?.[spec.name])
      const v = typed !== undefined ? applyHeaderTemplate(spec, typed) : nonEmpty(spec.default)
      if (v !== undefined) headers[spec.name] = v
      else if (spec.required) missing.push(spec.name)
    }
    let validUrl = false
    try {
      validUrl = /^https?:$/.test(new URL(url).protocol)
    } catch {
      validUrl = false
    }
    if (!validUrl && !missing.length) warnings.push(`"${url}" is not a valid server address.`)
    const config: ServerConfig = { type: option.transport === 'sse' ? 'sse' : 'http', url }
    if (Object.keys(headers).length) config.headers = headers
    return { ok: validUrl && missing.length === 0, config, missing, warnings }
  }

  if (!option.command) {
    warnings.push(option.notes ?? 'This server needs manual setup; follow the publisher’s instructions.')
    return { ok: false, missing, warnings }
  }
  const args = [...expandArgs(option.args ?? [], argValues, env), ...(values.extraArgs ?? []).filter((a) => a !== '')]
  const config: ServerConfig = { type: 'stdio', command: option.command, args }
  if (Object.keys(env).length) config.env = env
  return { ok: missing.length === 0, config, missing, warnings }
}
