/**
 * InstallOption (from the catalog) + InstallValues (what the user typed) → ServerConfig.
 *
 * Templates (option.command / option.args / option.url / header defaults / env defaults) may contain placeholders:
 *   {{NAME}}      → value of env var NAME (or header NAME)
 *   {{arg:NAME}}  → value of ArgSpec NAME
 * Rules:
 *   - A repeatable arg expands to several arguments: an element that is exactly "{{arg:X}}" becomes one argument
 *     per value; a flag followed by such an element ("--dir", "{{arg:X}}") repeats the pair; a mixed element
 *     ("--dir={{arg:X}}") is repeated per value.
 *   - Optional values left empty are omitted (with the flag that precedes them); required ones are reported.
 *   - ArgSpecs not referenced by any placeholder are appended as positional arguments, then values.extraArgs.
 * Defaults when option.command is absent:
 *   npm    → npx -y <pkg>[@version] …
 *   pypi   → uvx <pkg>[@version] …          (uv's documented exact-version form)
 *   docker → docker run -i --rm -e NAME… <image>[:version] …   (values stay in env, out of the process list)
 *   nuget  → dnx <pkg>[@version] --yes [-- args…]
 *   remote → { type: 'http' | 'sse', url, headers }
 */
import type { EnvVarSpec, InstallOption, InstallValues, ServerConfig } from '@shared/types'
import { serverConfigProblem } from '../targets/validate'

/** Required values are missing. `missing` lists env var / header / argument names. */
export class MissingValuesError extends Error {
  constructor(readonly missing: string[]) {
    super(`Fill in ${missing.length === 1 ? 'this value' : 'these values'} first: ${missing.join(', ')}.`)
    this.name = 'MissingValuesError'
  }
}

/** The option can't be turned into a launch config automatically (manual / mcpb / local HTTP servers…). */
export class UnsupportedOptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedOptionError'
  }
}

export interface BuildResult {
  config: ServerConfig
  /** Required values still empty (env var, header or argument names). */
  missing: string[]
  warnings: string[]
}

const PLACEHOLDER = /\{\{\s*(arg:)?([A-Za-z0-9_.-]+)\s*\}\}/g
const SINGLE_PLACEHOLDER = /^\{\{\s*(arg:)?([A-Za-z0-9_.-]+)\s*\}\}$/
const FLAG = /^--?[A-Za-z0-9][\w.-]*$/

const filled = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/**
 * Apply a value template such as "Bearer {{value}}" (the user types only the token).
 * A value that already starts with the template's prefix is kept as typed.
 */
export function applyTemplate(spec: Pick<EnvVarSpec, 'template'>, value: string): string {
  const template = spec.template
  if (!template || !template.includes('{{value}}')) return value
  const [prefix] = template.split('{{value}}')
  if (prefix && value.toLowerCase().startsWith(prefix.toLowerCase())) return value
  return template.split('{{value}}').join(value)
}

interface Ref {
  isArg: boolean
  name: string
}

function refsIn(text: string): Ref[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => ({ isArg: !!m[1], name: m[2] }))
}

/** Build leniently: missing required values are reported in `missing` instead of throwing. */
export function buildServerConfig(option: InstallOption, values: InstallValues = {}): BuildResult {
  const missing: string[] = []
  const warnings: string[] = []
  const addMissing = (name: string) => {
    if (!missing.includes(name)) missing.push(name)
  }

  // ── collect values ────────────────────────────────────────────────────────
  const envSpecs = option.env ?? []
  const headerSpecs = option.headers ?? []
  const argSpecs = option.argsSpec ?? []
  const pick = (specs: EnvVarSpec[], given: Record<string, string> | undefined) => {
    const out: Record<string, string> = {}
    for (const spec of specs) {
      const v = given?.[spec.name]
      if (filled(v)) out[spec.name] = applyTemplate(spec, v.trim())
      else if (filled(spec.default)) out[spec.name] = spec.default
    }
    for (const [k, v] of Object.entries(given ?? {})) if (!(k in out) && filled(v) && !specs.some((s) => s.name === k)) out[k] = v
    return out
  }
  const env = pick(envSpecs, values.env)
  const headers = pick(headerSpecs, values.headers)
  const argValues = new Map<string, string[]>()
  for (const spec of argSpecs) {
    const raw = values.args?.[spec.name]
    let list = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map((x) => String(x).trim()).filter(Boolean)
    if (!list.length && filled(spec.default)) list = [spec.default]
    if (!spec.repeatable) list = list.slice(0, 1)
    argValues.set(spec.name, list)
  }

  const isRequired = (r: Ref): boolean => {
    if (r.isArg) return argSpecs.find((s) => s.name === r.name)?.required ?? true
    const spec = envSpecs.find((s) => s.name === r.name) ?? headerSpecs.find((s) => s.name === r.name)
    return spec?.required ?? true
  }
  const valuesFor = (r: Ref): string[] => {
    if (r.isArg) {
      if (argValues.has(r.name)) return argValues.get(r.name)!
      const raw = values.args?.[r.name]
      return (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map((x) => String(x).trim()).filter(Boolean)
    }
    const v = env[r.name] ?? headers[r.name] ?? values.env?.[r.name] ?? values.headers?.[r.name]
    return filled(v) ? [v] : []
  }
  const referencedArgs = new Set<string>()

  /** Fill a single string. Empty placeholders → { empty: true } (and reported when required). */
  const fill = (text: string, override?: { ref: Ref; value: string }): { text: string; empty: boolean } => {
    let empty = false
    const out = text.replace(PLACEHOLDER, (_m, arg: string | undefined, name: string) => {
      const r: Ref = { isArg: !!arg, name }
      if (r.isArg) referencedArgs.add(name)
      if (override && override.ref.isArg === r.isArg && override.ref.name === name) return override.value
      const vals = valuesFor(r)
      if (!vals.length) {
        empty = true
        if (isRequired(r)) addMissing(name)
        return ''
      }
      return vals.join(',')
    })
    return { text: out, empty }
  }

  /** Expand an argument template list. */
  const expandArgs = (tpl: string[]): string[] => {
    const out: string[] = []
    for (let i = 0; i < tpl.length; i++) {
      const a = tpl[i]
      const next = tpl[i + 1]
      const single = next !== undefined ? SINGLE_PLACEHOLDER.exec(next) : null
      if (FLAG.test(a) && single) {
        const r: Ref = { isArg: !!single[1], name: single[2] }
        if (r.isArg) referencedArgs.add(r.name)
        const vals = valuesFor(r)
        if (!vals.length && isRequired(r)) addMissing(r.name)
        for (const v of vals) out.push(a, v)
        i++
        continue
      }
      const refs = refsIn(a)
      if (!refs.length) {
        out.push(a)
        continue
      }
      const multi = refs.find((r) => r.isArg && valuesFor(r).length > 1)
      if (multi) {
        referencedArgs.add(multi.name)
        for (const v of valuesFor(multi)) {
          const f = fill(a, { ref: multi, value: v })
          if (!f.empty) out.push(f.text)
        }
        continue
      }
      const f = fill(a)
      if (!f.empty) out.push(f.text)
    }
    return out
  }

  // fill placeholders inside env / header values (one level); values that end up empty are dropped
  for (const map of [env, headers]) {
    for (const k of Object.keys(map)) {
      map[k] = fill(map[k]).text
      if (!filled(map[k])) delete map[k]
    }
  }

  for (const spec of envSpecs) if (spec.required && !filled(env[spec.name])) addMissing(spec.name)
  for (const spec of headerSpecs) if (spec.required && !filled(headers[spec.name])) addMissing(spec.name)

  // ── remote ────────────────────────────────────────────────────────────────
  if (option.kind === 'remote') {
    if (!filled(option.url)) throw new UnsupportedOptionError(`"${option.label}" has no server address, so it can't be added automatically.`)
    const url = fill(option.url.trim()).text
    const config: ServerConfig = Object.keys(headers).length
      ? { type: option.transport === 'sse' ? 'sse' : 'http', url, headers }
      : { type: option.transport === 'sse' ? 'sse' : 'http', url }
    return { config, missing, warnings }
  }

  if (option.transport !== 'stdio') {
    throw new UnsupportedOptionError(
      `"${option.label}" runs on your computer as a web server, which Claude apps can't start by themselves. ` +
        'Start it yourself and add its address as a remote server.'
    )
  }

  // ── local (stdio) ─────────────────────────────────────────────────────────
  let command: string
  let args: string[]
  const pkg = option.package?.trim()
  if (filled(option.command)) {
    const c = fill(option.command.trim())
    command = c.text
    args = expandArgs(option.args ?? [])
  } else {
    if (!pkg && option.kind !== 'binary') {
      throw new UnsupportedOptionError(`"${option.label}" doesn't say which package to run, so it needs manual setup.`)
    }
    const extra = expandArgs(option.args ?? [])
    switch (option.kind) {
      case 'npm':
        command = 'npx'
        args = ['-y', option.version ? `${pkg}@${option.version}` : pkg!, ...extra]
        break
      case 'pypi':
        command = 'uvx'
        args = [option.version ? `${pkg}@${option.version}` : pkg!, ...extra]
        break
      case 'docker': {
        const image = option.version && !/[:@]/.test(pkg!.split('/').pop() ?? '') ? `${pkg}:${option.version}` : pkg!
        command = 'docker'
        args = ['run', '-i', '--rm', ...Object.keys(env).flatMap((k) => ['-e', k]), image, ...extra]
        break
      }
      case 'nuget':
        command = 'dnx'
        args = [option.version ? `${pkg}@${option.version}` : pkg!, '--yes', ...extra]
        break
      default:
        throw new UnsupportedOptionError(
          option.kind === 'mcpb'
            ? `"${option.label}" is a Claude Desktop extension (.mcpb). Install it by opening the file with Claude Desktop.`
            : `"${option.label}" needs manual setup — follow the instructions on its page.`
        )
    }
  }

  // ArgSpecs not referenced by any placeholder → positional args (after "--" for dnx)
  const positional: string[] = []
  for (const spec of argSpecs) {
    if (referencedArgs.has(spec.name)) continue
    const vals = argValues.get(spec.name) ?? []
    if (!vals.length && spec.required) addMissing(spec.name)
    positional.push(...vals)
  }
  const extraArgs = (values.extraArgs ?? []).map((a) => String(a)).filter((a) => a.trim() !== '')
  const tail = [...positional, ...extraArgs]
  if (tail.length && !filled(option.command) && option.kind === 'nuget') args.push('--')
  args.push(...tail)

  const config: ServerConfig = { type: 'stdio', command }
  if (args.length) config.args = args
  if (Object.keys(env).length) config.env = env
  if (Object.keys(headers).length) warnings.push('Headers only apply to remote servers, so they were ignored.')
  return { config, missing, warnings }
}

/** Build strictly: throws MissingValuesError / UnsupportedOptionError, or an Error for an unusable result. */
export function buildServerConfigStrict(option: InstallOption, values: InstallValues = {}): BuildResult {
  const result = buildServerConfig(option, values)
  if (result.missing.length) throw new MissingValuesError(result.missing)
  const problem = serverConfigProblem(result.config)
  if (problem) throw new UnsupportedOptionError(problem)
  return result
}
