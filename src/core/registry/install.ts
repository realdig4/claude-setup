/**
 * Builders and helpers for normalised InstallOptions.
 *
 * Launch templates are always explicit (`command` + `args`) for stdio options. Strings may contain
 * placeholders that launch.ts (buildServerConfig) expands at install time:
 *   {{arg:NAME}}  value of the ArgSpec NAME (an element holding a repeatable arg is emitted once per value;
 *                 an element for an optional arg left empty is dropped together with its "--NAME" flag)
 *   {{NAME}}      value of the EnvVarSpec NAME
 */
import type { ArgSpec, EnvVarSpec, InstallKind, InstallOption } from '@shared/types'
import { normalizeOciRef, remoteKey } from './keys'
import { compareVersions } from './util'
import type { HeaderSpec } from './types'

export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org'
export const DEFAULT_PYPI_INDEX = 'https://pypi.org/simple'
const MCPB_NOTE =
  'Bundle for Claude Desktop (Settings → Extensions → Advanced settings → Install Extension…). Other apps need it unpacked first.'

const LABELS: Record<InstallKind, string> = {
  npm: 'Node.js (npx)',
  pypi: 'Python (uvx)',
  docker: 'Docker',
  remote: 'Remote (hosted)',
  binary: 'Program',
  mcpb: 'Desktop extension (.mcpb)',
  nuget: '.NET (dnx)',
  manual: 'Manual setup'
}

/** Placeholder for an ArgSpec value. */
export function argPlaceholder(name: string): string {
  return `{{arg:${name}}}`
}

/** Placeholder for an EnvVarSpec value. */
export function envPlaceholder(name: string): string {
  return `{{${name}}}`
}

interface PackageOptionInput {
  package: string
  version?: string
  /** Arguments for the runner placed before the package (npx/uvx/docker run flags). */
  runtimeArgs?: string[]
  /** Arguments for the server placed after the package. */
  packageArgs?: string[]
  env?: EnvVarSpec[]
  argsSpec?: ArgSpec[]
  label?: string
  notes?: string
  /** Non-default registry / index URL. */
  registryBaseUrl?: string
  id?: string
}

function cleanVersion(version: string | undefined): string | undefined {
  const v = version?.trim()
  return v ? v : undefined
}

/** "pkg@1.2.3" (npm / uvx / dnx spec). */
export function packageSpec(pkg: string, version: string | undefined): string {
  const v = cleanVersion(version)
  return v ? `${pkg}@${v}` : pkg
}

function finish(option: InstallOption): InstallOption {
  if (!option.argsSpec?.length) delete option.argsSpec
  if (!option.headers?.length) delete option.headers
  if (!option.notes) delete option.notes
  if (!option.version) delete option.version
  return option
}

/** npx -y [runtimeArgs] [--registry X] pkg@version [packageArgs] */
export function npmOption(input: PackageOptionInput): InstallOption {
  const args = ['-y', ...(input.runtimeArgs ?? [])]
  if (input.registryBaseUrl && input.registryBaseUrl.replace(/\/+$/, '') !== DEFAULT_NPM_REGISTRY) {
    args.push('--registry', input.registryBaseUrl)
  }
  args.push(packageSpec(input.package, input.version), ...(input.packageArgs ?? []))
  return finish({
    id: input.id ?? 'npm',
    kind: 'npm',
    label: input.label ?? LABELS.npm,
    package: input.package,
    version: cleanVersion(input.version),
    runtime: 'node',
    transport: 'stdio',
    command: 'npx',
    args,
    env: input.env ?? [],
    argsSpec: input.argsSpec,
    notes: input.notes
  })
}

/** uvx [runtimeArgs] [--index-url X] pkg@version [packageArgs] */
export function pypiOption(input: PackageOptionInput): InstallOption {
  const args = [...(input.runtimeArgs ?? [])]
  const base = input.registryBaseUrl?.replace(/\/+$/, '')
  if (base && base !== DEFAULT_PYPI_INDEX && base !== 'https://pypi.org') args.push('--index-url', input.registryBaseUrl!)
  args.push(packageSpec(input.package, input.version), ...(input.packageArgs ?? []))
  return finish({
    id: input.id ?? 'pypi',
    kind: 'pypi',
    label: input.label ?? LABELS.pypi,
    package: input.package,
    version: cleanVersion(input.version),
    runtime: 'uv',
    transport: 'stdio',
    command: 'uvx',
    args,
    env: input.env ?? [],
    argsSpec: input.argsSpec,
    notes: input.notes
  })
}

/** dnx [runtimeArgs] pkg@version --yes [--source X] [-- packageArgs] */
export function nugetOption(input: PackageOptionInput): InstallOption {
  const args = [...(input.runtimeArgs ?? []), packageSpec(input.package, input.version), '--yes']
  if (input.registryBaseUrl && !/api\.nuget\.org/i.test(input.registryBaseUrl)) args.push('--source', input.registryBaseUrl)
  if (input.packageArgs?.length) args.push('--', ...input.packageArgs)
  return finish({
    id: input.id ?? 'nuget',
    kind: 'nuget',
    label: input.label ?? LABELS.nuget,
    package: input.package,
    version: cleanVersion(input.version),
    runtime: 'dotnet',
    transport: 'stdio',
    command: 'dnx',
    args,
    env: input.env ?? [],
    argsSpec: input.argsSpec,
    notes: input.notes
  })
}

/** Image reference with the version appended as tag when the identifier carries neither tag nor digest. */
export function imageRef(identifier: string, version?: string): string {
  const id = identifier.trim()
  const v = cleanVersion(version)
  const lastSlash = id.lastIndexOf('/')
  const hasTag = id.lastIndexOf(':') > lastSlash || id.includes('@sha256:')
  return v && !hasTag && v !== 'latest' ? `${id}:${v}` : id
}

/**
 * docker run -i --rm [runtimeArgs] [-e NAME …] image [packageArgs]
 * Every env spec is passed with `-e NAME` so secrets stay in the config's env, not in args.
 */
export function dockerOption(input: PackageOptionInput & { envArgs?: string[] }): InstallOption {
  const env = input.env ?? []
  const args = ['run', '-i', '--rm', ...(input.runtimeArgs ?? []), ...(input.envArgs ?? [])]
  for (const e of env) args.push('-e', e.name)
  const image = imageRef(input.package, input.version)
  args.push(image, ...(input.packageArgs ?? []))
  return finish({
    id: input.id ?? 'docker',
    kind: 'docker',
    label: input.label ?? LABELS.docker,
    package: image,
    version: cleanVersion(input.version),
    runtime: 'docker',
    transport: 'stdio',
    command: 'docker',
    args,
    env,
    argsSpec: input.argsSpec,
    notes: input.notes
  })
}

/** MCP bundle (.mcpb) download; Claude Desktop installs these natively. */
export function mcpbOption(input: {
  url: string
  version?: string
  sha256?: string
  env?: EnvVarSpec[]
  notes?: string
  id?: string
  label?: string
}): InstallOption {
  const option = finish({
    id: input.id ?? 'mcpb',
    kind: 'mcpb',
    label: input.label ?? LABELS.mcpb,
    package: input.url,
    version: cleanVersion(input.version),
    runtime: 'none',
    transport: 'stdio',
    env: input.env ?? [],
    notes: input.notes ?? MCPB_NOTE
  })
  if (input.sha256) (option as InstallOption & { sha256?: string }).sha256 = input.sha256
  return option
}

/** Hosted (remote) server reached over streamable HTTP or SSE. */
export function remoteOption(input: {
  url: string
  transport?: 'http' | 'sse'
  headers?: HeaderSpec[]
  argsSpec?: ArgSpec[]
  label?: string
  notes?: string
  id?: string
}): InstallOption {
  return finish({
    id: input.id ?? 'remote',
    kind: 'remote',
    label: input.label ?? (input.transport === 'sse' ? 'Remote (hosted, SSE)' : LABELS.remote),
    runtime: 'none',
    transport: input.transport ?? 'http',
    url: input.url,
    env: [],
    headers: input.headers,
    argsSpec: input.argsSpec,
    notes: input.notes
  })
}

/** Manual setup: no launch data, just instructions and a link. */
export function manualOption(input: { notes: string; url?: string; env?: EnvVarSpec[]; id?: string; label?: string }): InstallOption {
  return finish({
    id: input.id ?? 'manual',
    kind: 'manual',
    label: input.label ?? LABELS.manual,
    runtime: 'none',
    transport: 'stdio',
    url: input.url,
    env: input.env ?? [],
    notes: input.notes
  })
}

/** All user inputs of an option. */
function inputs(option: InstallOption): Array<{ required: boolean; secret: boolean }> {
  return [...option.env, ...(option.headers ?? []), ...(option.argsSpec ?? []).map((a) => ({ required: a.required, secret: false }))]
}

/** True when installing this option requires a secret (API key / token). */
export function optionNeedsKey(option: InstallOption): boolean {
  return [...option.env, ...(option.headers ?? [])].some((s) => s.required && s.secret && s.default === undefined)
}

/** True when every option requires a secret. Servers without options do not "need a key". */
export function serverNeedsKey(options: InstallOption[]): boolean {
  const installable = options.filter((o) => o.kind !== 'manual')
  return installable.length > 0 && installable.every(optionNeedsKey)
}

/** Lower is better: preferred default option for beginners. */
export function optionRank(option: InstallOption): number {
  const required = inputs(option).some((i) => i.required)
  switch (option.kind) {
    case 'remote': {
      const urlArgs = (option.argsSpec ?? []).some((a) => a.required)
      const sse = option.transport === 'sse' ? 0.5 : 0
      if (urlArgs) return 6 + sse
      return (required ? 1 : 0) + sse
    }
    case 'npm':
      return 2
    case 'pypi':
      return 3
    case 'docker':
      return 4
    case 'nuget':
      return 5
    case 'mcpb':
      return 7
    case 'binary':
      return 8
    default:
      return 9
  }
}

/** Identity of an option for de-duplication across sources. */
export function optionDedupeKey(option: InstallOption): string {
  switch (option.kind) {
    case 'remote':
      return `remote|${(option.url && remoteKey(option.url)) ?? option.url ?? option.id}`
    case 'docker':
      return `docker|${option.package ? normalizeOciRef(option.package) : option.id}`
    case 'npm':
    case 'nuget':
      return `${option.kind}|${(option.package ?? option.id).toLowerCase()}`
    case 'pypi':
      return `pypi|${(option.package ?? option.id).toLowerCase().replace(/[-_.]+/g, '-')}`
    case 'mcpb':
      return `mcpb|${option.package ?? option.id}`
    default:
      return `${option.kind}|${option.url ?? option.package ?? option.id}`
  }
}

/** Escape a string for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Return a copy of an npm / pypi / nuget option pinned to a newer version (args are rewritten).
 * Other kinds and non-newer versions are returned unchanged.
 */
export function bumpOptionVersion(option: InstallOption, version: string | undefined): InstallOption {
  const next = cleanVersion(version)
  if (!next || next === 'latest' || !option.package || !option.version || option.version === 'latest') return option
  if (option.kind !== 'npm' && option.kind !== 'pypi' && option.kind !== 'nuget') return option
  if (compareVersions(next, option.version) <= 0) return option
  const re = new RegExp(`^${escapeRe(option.package)}(@|==)${escapeRe(option.version)}$`, 'i')
  let changed = false
  const args = (option.args ?? []).map((a) => {
    const m = re.exec(a)
    if (!m) return a
    changed = true
    return `${option.package}${m[1]}${next}`
  })
  return changed ? { ...option, version: next, args } : option
}

/** Make option ids unique within one server: npm, npm-2, remote, remote-2… */
export function assignOptionIds(options: InstallOption[]): InstallOption[] {
  const used = new Map<string, number>()
  return options.map((o) => {
    const base = o.id && /^[a-z0-9-]+$/.test(o.id) ? o.id.replace(/-\d+$/, '') : o.kind
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    return { ...o, id: n === 1 ? base : `${base}-${n}` }
  })
}

/** Stable sort by preference rank. */
export function sortOptions(options: InstallOption[]): InstallOption[] {
  return options
    .map((o, i) => ({ o, i, r: optionRank(o) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.o)
}
