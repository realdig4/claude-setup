/**
 * The install wizard's settings form, generated from an InstallOption's env / headers / argsSpec:
 * field models with friendly labels, initial values, validation and conversion to InstallValues.
 * Pure TypeScript (unit-tested in Node).
 */
import type { ArgSpec, EnvVarSpec, InstallOption, InstallValues } from '@shared/types'

export type FieldKind = 'env' | 'header' | 'arg'
export type FieldFormat = 'string' | 'path' | 'directory' | 'url' | 'number' | 'boolean'

/** One generated form field. */
export interface FormField {
  /** Unique within the form: "env:BRAVE_API_KEY", "header:Authorization", "arg:directories". */
  key: string
  kind: FieldKind
  /** Raw name (env var, header or argument). */
  name: string
  /** Plain-words label ("Brave API key"). */
  label: string
  description?: string
  required: boolean
  secret: boolean
  format: FieldFormat
  repeatable: boolean
  placeholder?: string
  helpUrl?: string
  default?: string
  /** Header that is sent as "Bearer <token>" — the form adds the prefix when only the token is pasted. */
  bearer: boolean
}

/** Form values by field key. Repeatable fields hold a list. Switches hold 'true' or ''. */
export type FormValues = Record<string, string | string[]>

const WORDS = new Map<string, string>([
  ['api', 'API'],
  ['url', 'URL'],
  ['urls', 'URLs'],
  ['uri', 'URI'],
  ['id', 'ID'],
  ['ids', 'IDs'],
  ['mcp', 'MCP'],
  ['aws', 'AWS'],
  ['gcp', 'GCP'],
  ['sql', 'SQL'],
  ['db', 'DB'],
  ['json', 'JSON'],
  ['http', 'HTTP'],
  ['https', 'HTTPS'],
  ['ssh', 'SSH'],
  ['pat', 'PAT'],
  ['oauth', 'OAuth'],
  ['github', 'GitHub'],
  ['gitlab', 'GitLab'],
  ['ai', 'AI'],
  ['llm', 'LLM'],
  ['jwt', 'JWT'],
  ['ssl', 'SSL'],
  ['tls', 'TLS'],
  ['dns', 'DNS'],
  ['ip', 'IP'],
  ['openai', 'OpenAI'],
  ['mysql', 'MySQL'],
  ['postgresql', 'PostgreSQL'],
  ['k8s', 'K8s'],
  ['directories', 'folders'],
  ['directory', 'folder'],
  ['dirs', 'folders'],
  ['dir', 'folder']
])

/** "BRAVE_API_KEY" → "Brave API key", "local-timezone" → "Local timezone", "directories" → "Folders". */
export function humanizeName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean)
  if (words.length === 0) return name
  return words
    .map((word, i) => {
      const lower = word.toLowerCase()
      const known = WORDS.get(lower)
      const text = known ?? lower
      if (i > 0 || (known && known !== known.toLowerCase())) return text
      return text.charAt(0).toUpperCase() + text.slice(1)
    })
    .join(' ')
}

function isBearerHeader(spec: EnvVarSpec): boolean {
  if (spec.name.toLowerCase() !== 'authorization') return false
  const text = `${spec.placeholder ?? ''} ${spec.description ?? ''} ${spec.default ?? ''}`
  return /bearer/i.test(text)
}

function fromEnv(spec: EnvVarSpec, kind: 'env' | 'header'): FormField {
  const bearer = kind === 'header' && isBearerHeader(spec)
  const label = kind === 'header' && spec.name.toLowerCase() === 'authorization' && spec.secret ? 'Access token' : humanizeName(spec.name)
  return {
    key: `${kind}:${spec.name}`,
    kind,
    name: spec.name,
    label,
    description: spec.description,
    required: spec.required,
    secret: spec.secret,
    format: spec.format ?? 'string',
    repeatable: false,
    placeholder: bearer && spec.placeholder ? spec.placeholder.replace(/^Bearer\s+/i, '') : spec.placeholder,
    helpUrl: spec.helpUrl,
    default: spec.default,
    bearer
  }
}

function fromArg(spec: ArgSpec): FormField {
  return {
    key: `arg:${spec.name}`,
    kind: 'arg',
    name: spec.name,
    label: humanizeName(spec.name),
    description: spec.description,
    required: spec.required,
    secret: false,
    format: spec.format ?? 'string',
    repeatable: !!spec.repeatable,
    default: spec.default,
    bearer: false
  }
}

/** Fields for an option: required ones first (arguments, then env, then headers), then optional ones. */
export function formFields(option: InstallOption): FormField[] {
  const all = [
    ...(option.argsSpec ?? []).map(fromArg),
    ...option.env.map((e) => fromEnv(e, 'env')),
    ...(option.headers ?? []).map((h) => fromEnv(h, 'header'))
  ]
  return [...all.filter((f) => isRequired(f)), ...all.filter((f) => !isRequired(f))]
}

/** Must the user fill it in (required and no default)? */
export function isRequired(field: FormField): boolean {
  return field.required && !field.default
}

/** Starting values: defaults, or empty. */
export function initialValues(fields: readonly FormField[]): FormValues {
  const values: FormValues = {}
  for (const field of fields) {
    if (field.repeatable) values[field.key] = field.default ? [field.default] : []
    else if (field.format === 'boolean') values[field.key] = isTruthy(field.default) ? 'true' : ''
    else values[field.key] = field.default ?? ''
  }
  return values
}

function isTruthy(value: string | undefined): boolean {
  return !!value && /^(1|true|yes|on)$/i.test(value.trim())
}

function listOf(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return (Array.isArray(value) ? value : [value]).map((v) => v.trim()).filter(Boolean)
}

function textOf(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? (value[0] ?? '') : (value ?? '')).trim()
}

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i
const NUMBER_RE = /^-?\d+(\.\d+)?$/

function emptyMessage(field: FormField): string {
  if (field.repeatable) return field.format === 'directory' ? 'Add at least one folder.' : 'Add at least one value.'
  if (field.secret) return field.kind === 'header' ? 'Paste your token to continue.' : 'Paste your key to continue.'
  if (field.format === 'directory') return 'Choose a folder.'
  if (field.format === 'path') return 'Choose a file.'
  if (field.format === 'url') return 'Enter the address.'
  return 'Fill this in to continue.'
}

/** Field problems by key (empty object = valid). */
export function validateValues(fields: readonly FormField[], values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const field of fields) {
    const raw = values[field.key]
    if (field.repeatable) {
      if (isRequired(field) && listOf(raw).length === 0) errors[field.key] = emptyMessage(field)
      continue
    }
    if (field.format === 'boolean') continue
    const text = textOf(raw)
    if (!text) {
      if (isRequired(field)) errors[field.key] = emptyMessage(field)
      continue
    }
    if (/[\r\n]/.test(text)) errors[field.key] = 'This can’t contain line breaks.'
    else if (field.format === 'url' && !URL_RE.test(text)) errors[field.key] = 'Enter a full address, like https://example.com'
    else if (field.format === 'number' && !NUMBER_RE.test(text)) errors[field.key] = 'Enter a number.'
  }
  return errors
}

/** Header value as it must be sent ("Bearer " added when only a token was pasted). */
export function headerValue(field: FormField, value: string): string {
  const text = value.trim()
  if (!field.bearer || /\s/.test(text)) return text
  return `Bearer ${text}`
}

/** Convert form values (plus extra raw arguments) into the core's InstallValues. Empty optional values are left out. */
export function toInstallValues(fields: readonly FormField[], values: FormValues, extraArgs: readonly string[] = []): InstallValues {
  const env: Record<string, string> = {}
  const headers: Record<string, string> = {}
  const args: Record<string, string | string[]> = {}
  for (const field of fields) {
    const raw = values[field.key]
    if (field.repeatable) {
      const list = listOf(raw)
      if (list.length) args[field.name] = list
      continue
    }
    let text = textOf(raw)
    if (field.format === 'boolean') {
      // On → "true". Off → left out, unless the server's default is on (then it must be switched off explicitly).
      if (text !== 'true') {
        if (!isTruthy(field.default)) continue
        text = 'false'
      }
    }
    if (!text) continue
    if (field.kind === 'env') env[field.name] = text
    else if (field.kind === 'header') headers[field.name] = headerValue(field, text)
    else args[field.name] = text
  }
  const extra = extraArgs.map((a) => a.trim()).filter(Boolean)
  const out: InstallValues = {}
  if (Object.keys(env).length) out.env = env
  if (Object.keys(headers).length) out.headers = headers
  if (Object.keys(args).length) out.args = args
  if (extra.length) out.extraArgs = extra
  return out
}

/** Secret values typed into the form (to hide them in previews). */
export function secretValues(fields: readonly FormField[], values: FormValues): string[] {
  const out: string[] = []
  for (const field of fields) {
    if (!field.secret) continue
    const text = textOf(values[field.key])
    if (text.length >= 4) out.push(text, headerValue(field, text))
  }
  return [...new Set(out)]
}

/** Replace every occurrence of the given secrets with a masked form ("ghp_••••abcd"). */
export function maskSecrets(text: string, secrets: readonly string[], mask: (secret: string) => string): string {
  let out = text
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length < 4) continue
    out = out.split(secret).join(mask(secret))
    // JSON snippets escape quotes and backslashes — hide the escaped form too.
    const escaped = JSON.stringify(secret).slice(1, -1)
    if (escaped !== secret) out = out.split(escaped).join(mask(secret))
  }
  return out
}
