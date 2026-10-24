/**
 * server.json (MCP registry schema 2025-09-29 / 2025-12-11) → normalised InstallOptions + matching keys.
 * Mirrors VS Code's McpServerManifestParser (research §1.9) with a few safety changes:
 *  - `npx -y` so installs never hang on a prompt; default registry URLs are omitted
 *  - optional inputs become droppable placeholders instead of always-asked prompts
 *  - docker `-e NAME={var}` runtime args become env specs (secrets stay out of args)
 *  - packages that run a local HTTP server, cargo crates and unknown types become "manual" options
 */
import type { ArgSpec, EnvVarSpec, InstallOption } from '@shared/types'
import {
  argPlaceholder,
  dockerOption,
  manualOption,
  mcpbOption,
  npmOption,
  nugetOption,
  pypiOption,
  remoteOption,
  sortOptions
} from './install'
import { packageKey, parseRepoUrl, remoteKey, repoKey, softRemoteKey, type RepoRef } from './keys'
import type { HeaderSpec } from './types'
import { asArray, asRecord, asString, cleanText, isHttpUrl, isImageUrl } from './util'

/** Loosely typed server.json input (registries are not strict about the schema). */
export type ServerJson = Record<string, unknown>

/** Max optional (droppable) argument specs per option, to keep install forms short. */
const MAX_OPTIONAL_ARGS = 10
/** Max options per server (some registry entries list dozens of remotes). */
export const MAX_OPTIONS = 15

const RISKY_DOCKER_FLAGS = new Set([
  '-v',
  '--volume',
  '--mount',
  '-p',
  '--publish',
  '--network',
  '--net',
  '--privileged',
  '--cap-add',
  '--device',
  '--pid',
  '--ipc',
  '-u',
  '--user',
  '--userns'
])

interface Input {
  name?: string
  value?: string
  valueHint?: string
  default?: string
  description?: string
  format?: string
  isRequired?: boolean
  isSecret?: boolean
  isRepeated?: boolean
  placeholder?: string
  choices?: string[]
  type?: string
  variables?: Record<string, Input>
}

function toInput(raw: unknown): Input | undefined {
  const r = asRecord(raw)
  if (!r) return undefined
  const vars = asRecord(r.variables)
  const variables: Record<string, Input> = {}
  if (vars) for (const [k, v] of Object.entries(vars)) variables[k] = toInput(v) ?? {}
  const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined)
  return {
    name: str(r.name),
    value: str(r.value),
    valueHint: str(r.valueHint ?? r.value_hint),
    default: str(r.default),
    description: asString(r.description),
    format: str(r.format),
    isRequired: r.isRequired === true || r.is_required === true,
    isSecret: r.isSecret === true || r.is_secret === true,
    isRepeated: r.isRepeated === true || r.is_repeated === true,
    placeholder: asString(r.placeholder),
    choices: asArray(r.choices).filter((c): c is string => typeof c === 'string'),
    type: str(r.type),
    variables
  }
}

/** First https URL mentioned in a description (used as "get your key here" link). */
function helpUrlFrom(description: string | undefined): string | undefined {
  const m = description?.match(/https?:\/\/[^\s)\]>"']+/)
  return m ? m[0].replace(/[.,;:]+$/, '') : undefined
}

function describe(input: Input): string | undefined {
  const parts = [input.description ? cleanText(input.description) : '']
  if (input.choices?.length) parts.push(`Allowed values: ${input.choices.join(', ')}.`)
  const text = parts.filter(Boolean).join(' ')
  return text || undefined
}

function envFormat(format: string | undefined): EnvVarSpec['format'] {
  switch (format) {
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'filepath':
    case 'path':
      return 'path'
    case 'directory':
      return 'directory'
    case 'url':
    case 'uri':
      return 'url'
    default:
      return undefined
  }
}

function argFormat(format: string | undefined): ArgSpec['format'] {
  const f = envFormat(format)
  return f === 'boolean' ? undefined : f
}

function sanitizeArgName(name: string): string {
  return name.replace(/^-+/, '').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'value'
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
/** {var} or ${var} template token (global: only use with replace / matchAll). */
const TOKEN = /\$?\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g
/** Non-global variant for tests. */
const HAS_TOKEN = /\$?\{[A-Za-z_][A-Za-z0-9_.-]*\}/

/** Collects specs while one option's launch template is built. */
class SpecCollector {
  readonly argsSpec: ArgSpec[] = []
  readonly env: EnvVarSpec[] = []
  readonly notes: string[] = []
  private optionalArgs = 0
  private skippedOptional = 0

  /** Register an ArgSpec (deduplicated by name) and return its placeholder. */
  arg(spec: ArgSpec): string | undefined {
    const existing = this.argsSpec.find((a) => a.name === spec.name)
    if (existing) {
      existing.required ||= spec.required
      return argPlaceholder(existing.name)
    }
    if (!spec.required) {
      if (this.optionalArgs >= MAX_OPTIONAL_ARGS) {
        this.skippedOptional++
        return undefined
      }
      this.optionalArgs++
    }
    this.argsSpec.push(spec)
    return argPlaceholder(spec.name)
  }

  addEnv(spec: EnvVarSpec): void {
    const i = this.env.findIndex((e) => e.name === spec.name)
    if (i >= 0) this.env[i] = { ...this.env[i], ...spec, required: this.env[i].required || spec.required }
    else this.env.push(spec)
  }

  finishNotes(): string | undefined {
    if (this.skippedOptional) {
      this.notes.push(`${this.skippedOptional} more optional setting(s) are described in the publisher's documentation.`)
    }
    return this.notes.length ? this.notes.join(' ') : undefined
  }
}

/** Variables of a template that the user must (or may) fill in. */
function openVariables(template: string, variables: Record<string, Input> | undefined): Array<[string, Input]> {
  return [...template.matchAll(TOKEN)]
    .map((m) => [m[1], variables?.[m[1]]] as const)
    .filter((x): x is readonly [string, Input] => !!x[1] && (x[1].value === undefined || x[1].value === ''))
    .map(([n, v]) => [n, v])
}

/**
 * Replace {var} tokens of a template with arg placeholders (undeclared tokens stay literal).
 * `argName` renames the placeholder of a value that is exactly one variable (named flags use the
 * flag name so launch.ts can drop "--flag value" together).
 */
function fillTemplate(
  template: string,
  variables: Record<string, Input> | undefined,
  owner: Input,
  specs: SpecCollector,
  argName?: string
): string | undefined {
  let missingRequired = false
  const out = template.replace(TOKEN, (whole, name: string) => {
    const v = variables?.[name]
    if (!v) return whole
    if (v.value !== undefined && v.value !== '') return v.value
    const placeholder = specs.arg({
      name: argName ?? sanitizeArgName(name),
      description: describe(v) ?? describe(owner),
      required: v.isRequired || owner.isRequired || false,
      format: argFormat(v.format),
      default: v.default
    })
    if (!placeholder) {
      missingRequired = true
      return whole
    }
    return placeholder
  })
  return missingRequired ? undefined : out
}

/** Expand runtimeArguments / packageArguments into launch template elements. */
function processArguments(list: unknown[], specs: SpecCollector, opts: { docker: boolean }): string[] {
  const args: string[] = []
  const optionalFlags: string[] = []
  for (const raw of list) {
    const a = toInput(raw)
    if (!a) continue
    if (a.type === 'named') {
      const flag = a.name?.trim()
      if (!flag) continue
      if (opts.docker && RISKY_DOCKER_FLAGS.has(flag)) specs.notes.push(`Uses Docker option ${flag}${a.value ? ' ' + a.value : ''}.`)
      // docker -e NAME={var}: turn into an env spec so the value lives in the config's env block.
      if (opts.docker && (flag === '-e' || flag === '--env') && a.value) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(a.value)
        if (m && (HAS_TOKEN.test(m[2]) || m[2] === '')) {
          const vars = Object.values(a.variables ?? {})
          specs.addEnv({
            name: m[1],
            description: describe(a) ?? vars.map(describe).find(Boolean),
            required: a.isRequired || vars.some((v) => v.isRequired) || false,
            secret: a.isSecret || vars.some((v) => v.isSecret) || false,
            default: vars.length === 1 ? vars[0].default : undefined,
            helpUrl: helpUrlFrom(a.description)
          })
          continue
        }
      }
      if (a.value !== undefined && a.value !== '') {
        const open = openVariables(a.value, a.variables)
        const single = open.length === 1 && a.value.trim() === `{${open[0][0]}}`
        const optional = open.some(([, v]) => !v.isRequired && v.default === undefined)
        // "--flag text {var}" with an optional variable cannot be dropped cleanly: leave it to the user.
        if (!single && optional && !a.isRequired) {
          optionalFlags.push(flag)
          continue
        }
        const value = fillTemplate(a.value, a.variables, a, specs, single ? sanitizeArgName(flag) : undefined)
        if (value === undefined) continue
        args.push(flag, value)
        continue
      }
      if (a.format === 'boolean') {
        if (a.isRequired) args.push(flag)
        else optionalFlags.push(flag)
        continue
      }
      if (!a.isRequired && !a.description && a.default === undefined) continue
      const placeholder = specs.arg({
        name: sanitizeArgName(flag),
        description: describe(a),
        required: a.isRequired ?? false,
        repeatable: a.isRepeated || undefined,
        format: argFormat(a.format),
        default: a.default
      })
      if (placeholder) args.push(flag, placeholder)
      continue
    }
    // positional
    if (a.value !== undefined && a.value !== '') {
      const value = fillTemplate(a.value, a.variables, a, specs)
      if (value !== undefined) args.push(value)
      continue
    }
    const hint = a.valueHint ?? a.name
    if (!hint) {
      if (a.default) args.push(a.default)
      continue
    }
    const placeholder = specs.arg({
      name: sanitizeArgName(hint),
      description: describe(a),
      required: a.isRequired ?? false,
      repeatable: a.isRepeated || undefined,
      format: argFormat(a.format),
      default: a.default
    })
    if (placeholder) args.push(placeholder)
  }
  if (optionalFlags.length) specs.notes.push(`Optional flags: ${optionalFlags.join(', ')}.`)
  return args
}

/** environmentVariables → env specs. */
function processEnv(list: unknown[], specs: SpecCollector): void {
  for (const raw of list) {
    const e = toInput(raw)
    if (!e?.name || !ENV_NAME.test(e.name)) continue
    const vars = Object.values(e.variables ?? {})
    const hasTemplate = e.value !== undefined && HAS_TOKEN.test(e.value)
    if (e.value && !hasTemplate) {
      specs.addEnv({ name: e.name, description: describe(e), required: false, secret: e.isSecret ?? false, default: e.value })
      continue
    }
    let def = e.default
    if (hasTemplate && vars.length && vars.every((v) => v.default !== undefined)) {
      def = e.value!.replace(TOKEN, (whole, n: string) => e.variables?.[n]?.default ?? whole)
    }
    specs.addEnv({
      name: e.name,
      description: describe(e),
      required: e.isRequired || vars.some((v) => v.isRequired) || false,
      secret: e.isSecret || vars.some((v) => v.isSecret) || false,
      default: def,
      placeholder: hasTemplate ? e.value : e.placeholder,
      format: envFormat(e.format),
      helpUrl: e.isSecret ? helpUrlFrom(e.description) : undefined
    })
  }
}

/** One header (KeyValueInput) → header spec with an optional "Bearer {{value}}" template. */
export function headerSpec(raw: unknown, extraVariables?: Record<string, Input>): HeaderSpec | undefined {
  const h = toInput(raw)
  const name = h?.name?.trim()
  if (!h || !name) return undefined
  const spec: HeaderSpec = {
    name,
    description: describe(h),
    required: h.isRequired ?? false,
    secret: h.isSecret ?? false,
    default: h.default,
    placeholder: h.placeholder,
    helpUrl: h.isSecret ? helpUrlFrom(h.description) : undefined
  }
  const value = h.value
  if (value) {
    const tokens = [...value.matchAll(TOKEN)]
    if (!tokens.length) {
      spec.default = value
      spec.required = false
      spec.secret = h.isSecret ?? false
    } else {
      const vars = { ...(extraVariables ?? {}), ...(h.variables ?? {}) }
      const declared = tokens.map((t) => vars[t[1]]).filter((v): v is Input => !!v)
      spec.secret = spec.secret || declared.some((v) => v.isSecret) || tokens.some((t) => /key|token|secret|password|auth/i.test(t[1]))
      spec.required = spec.required || declared.some((v) => v.isRequired) || declared.length < tokens.length
      if (!spec.description) spec.description = declared.map(describe).find(Boolean)
      if (tokens.length === 1) {
        spec.template = value.replace(tokens[0][0], '{{value}}')
        spec.placeholder = value.replace(tokens[0][0], `<${tokens[0][1]}>`)
      } else {
        spec.placeholder = value.replace(TOKEN, (_w, n: string) => `<${n}>`)
      }
    }
  } else if (!spec.placeholder && /^authorization$/i.test(name) && spec.secret) {
    spec.placeholder = 'Bearer <token>'
  }
  return spec
}

/** One remote → remote option (undefined for unsupported transports). */
export function remoteFromJson(raw: unknown, index: number, total: number): InstallOption | undefined {
  const r = asRecord(raw)
  const type = asString(r?.type)
  let url = asString(r?.url)
  if (!r || !url || (type !== 'streamable-http' && type !== 'sse' && type !== 'http')) return undefined
  const specs = new SpecCollector()
  const variables: Record<string, Input> = {}
  const vr = asRecord(r.variables)
  if (vr) for (const [k, v] of Object.entries(vr)) variables[k] = toInput(v) ?? {}
  // URL template variables (declared or not) become required args.
  url = url.replace(TOKEN, (_whole, name: string) => {
    const v = variables[name]
    return (
      specs.arg({
        name: sanitizeArgName(name),
        description: v ? describe(v) : `Value for {${name}} in the server address`,
        required: v ? v.isRequired !== false || v.default === undefined : true,
        format: name.toLowerCase() === 'url' ? 'url' : argFormat(v?.format),
        default: v?.default
      }) ?? ''
    )
  })
  if (url === '' || (!/^https?:\/\//i.test(url) && !url.startsWith('{{arg:'))) return undefined
  const headers = asArray(r.headers)
    .map((h) => headerSpec(h, variables))
    .filter((h): h is HeaderSpec => !!h)
  let label: string | undefined
  if (total > 1 && index > 0) {
    try {
      const u = new URL(url.replace(/\{\{arg:[^}]+\}\}/g, 'x'))
      label = `Remote (${u.host}${u.pathname.replace(/\/+$/, '')})`
    } catch {
      label = undefined
    }
  }
  return remoteOption({
    url,
    transport: type === 'sse' ? 'sse' : 'http',
    headers,
    argsSpec: specs.argsSpec,
    label: label ?? (type === 'sse' ? 'Remote (hosted, SSE)' : undefined),
    notes: specs.finishNotes()
  })
}

/** One package → install option (undefined when the package cannot be represented). */
export function packageFromJson(raw: unknown, repository?: string): InstallOption | undefined {
  const p = asRecord(raw)
  if (!p) return undefined
  const registryType = (asString(p.registryType ?? p.registry_type) ?? '').toLowerCase()
  const identifier = asString(p.identifier ?? p.name)
  if (!identifier) return undefined
  const version = asString(p.version)
  const transport = asString(asRecord(p.transport)?.type) ?? 'stdio'
  const registryBaseUrl = asString(p.registryBaseUrl ?? p.registry_base_url)
  if (transport !== 'stdio') {
    const pkg = `${identifier}${version ? ' ' + version : ''}`
    return manualOption({
      notes:
        `This server runs on your computer as a local web service (${transport}). ` +
        `Start it yourself (package ${pkg}) and add its address as a remote server.`,
      url: repository
    })
  }
  const docker = registryType === 'oci' || registryType === 'docker'
  const specs = new SpecCollector()
  const runtimeArgs = processArguments(asArray(p.runtimeArguments ?? p.runtime_arguments), specs, { docker })
  processEnv(asArray(p.environmentVariables ?? p.environment_variables), specs)
  const packageArgs = processArguments(asArray(p.packageArguments ?? p.package_arguments), specs, { docker: false })
  const base = { package: identifier, version, runtimeArgs, packageArgs, env: specs.env, argsSpec: specs.argsSpec, registryBaseUrl }
  switch (registryType) {
    case 'npm':
      return npmOption({ ...base, notes: specs.finishNotes() })
    case 'pypi':
      return pypiOption({ ...base, notes: specs.finishNotes() })
    case 'nuget':
      return nugetOption({ ...base, notes: specs.finishNotes() })
    case 'oci':
    case 'docker': {
      let image = identifier
      if (registryBaseUrl && !/docker\.io/i.test(registryBaseUrl)) {
        const host = registryBaseUrl.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '')
        const first = identifier.split('/')[0]
        if (!(first.includes('.') || first.includes(':'))) image = `${host}/${identifier}`
      }
      return dockerOption({ ...base, package: image, notes: specs.finishNotes() })
    }
    case 'mcpb':
      if (!isHttpUrl(identifier)) return undefined
      return mcpbOption({ url: identifier, version, sha256: asString(p.fileSha256 ?? p.file_sha256), env: specs.env })
    case 'cargo':
      return manualOption({
        notes:
          `Install it with Rust: cargo install ${identifier}${version ? ` --version ${version}` : ''} --locked — ` +
          'then add the installed program as a server.',
        url: repository,
        env: specs.env
      })
    default: {
      const hint = asString(p.runtimeHint ?? p.runtime_hint)
      const what = `${registryType || 'unknown'} package ${identifier}${hint ? `, run with ${hint}` : ''}`
      return manualOption({
        notes: `Needs manual setup (${what}). Follow the publisher's instructions.`,
        url: repository,
        env: specs.env
      })
    }
  }
}

export interface ServerJsonInstall {
  options: InstallOption[]
  keys: string[]
  softKeys: string[]
  repo?: RepoRef
}

/** All install options + matching keys of a server.json document. */
export function mapServerJson(server: ServerJson): ServerJsonInstall {
  const keys: string[] = []
  const softKeys: string[] = []
  const repoRec = asRecord(server.repository)
  const repo = parseRepoUrl(asString(repoRec?.url), asString(repoRec?.subfolder))
  const repoLink = asString(repoRec?.url)
  if (repo) keys.push(repoKey(repo))
  const options: InstallOption[] = []
  const remotes = asArray(server.remotes)
  remotes.forEach((r, i) => {
    const opt = remoteFromJson(r, i, remotes.length)
    if (opt) options.push(opt)
    const url = asString(asRecord(r)?.url)
    const k = url ? remoteKey(url) : undefined
    if (k) keys.push(k)
    const sk = url ? softRemoteKey(url) : undefined
    if (sk) softKeys.push(sk)
  })
  for (const p of asArray(server.packages)) {
    const rec = asRecord(p)
    const type = asString(rec?.registryType ?? rec?.registry_type)
    const id = asString(rec?.identifier)
    if (type && id) {
      const k = packageKey(type, id)
      if (k) keys.push(k)
    }
    const opt = packageFromJson(p, repoLink)
    if (opt) options.push(opt)
  }
  const installable = options.filter((o) => o.kind !== 'manual')
  const chosen = installable.length ? installable : options.slice(0, 1)
  return { options: sortOptions(chosen).slice(0, MAX_OPTIONS), keys, softKeys, repo }
}

export interface ServerJsonBasics {
  name: string
  title?: string
  description: string
  version?: string
  websiteUrl?: string
  repositoryUrl?: string
  iconUrl?: string
}

/** Descriptive fields of a server.json document. */
export function serverJsonBasics(server: ServerJson): ServerJsonBasics {
  const icons = asArray(server.icons)
    .map((i) => asRecord(i))
    .filter((i): i is Record<string, unknown> => !!i && isHttpUrl(i.src))
  const icon =
    icons.find((i) => i.theme !== 'dark' && /svg|png/.test(String(i.mimeType ?? ''))) ?? icons.find((i) => i.theme !== 'dark') ?? icons[0]
  const repoUrl = asString(asRecord(server.repository)?.url)
  const website = asString(server.websiteUrl)
  return {
    name: asString(server.name) ?? '',
    title: asString(server.title),
    description: cleanText(server.description),
    version: asString(server.version),
    websiteUrl: isHttpUrl(website) ? website : undefined,
    repositoryUrl: isHttpUrl(repoUrl) ? repoUrl.replace(/\.git$/, '') : undefined,
    iconUrl: icon && isImageUrl(icon.src) ? (icon.src as string) : (icon?.src as string | undefined)
  }
}
