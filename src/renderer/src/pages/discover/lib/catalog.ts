/**
 * Pure helpers for catalog servers and their install options: plain-words labels, the default option the
 * core would pick, and "needs a key / works online" checks. No React / DOM imports (unit-tested in Node).
 */
import type { CatalogServer, CatalogSource, InstallKind, InstallOption, RuntimeId } from '@shared/types'

/** Registry names shown in Advanced mode. */
export const SOURCE_LABELS: Record<CatalogSource, string> = {
  official: 'MCP Registry',
  anthropic: 'Claude Connectors',
  github: 'GitHub Registry',
  smithery: 'Smithery',
  docker: 'Docker Catalog',
  cline: 'Cline Marketplace',
  awesome: 'Awesome MCP list',
  glama: 'Glama',
  pulsemcp: 'PulseMCP',
  seed: 'Hand-picked'
}

/** Every source, in a sensible order for filters. */
export const SOURCE_ORDER: readonly CatalogSource[] = [
  'official',
  'anthropic',
  'github',
  'smithery',
  'docker',
  'cline',
  'awesome',
  'glama',
  'pulsemcp',
  'seed'
]

export const RUNTIME_LABELS: Record<RuntimeId, string> = {
  node: 'Node.js',
  uv: 'uv (Python)',
  python: 'Python',
  docker: 'Docker',
  dotnet: '.NET',
  none: 'Nothing'
}

export const KIND_LABELS: Record<InstallKind, string> = {
  npm: 'npm',
  pypi: 'PyPI',
  docker: 'Docker',
  remote: 'Remote',
  binary: 'Program',
  mcpb: 'MCP bundle',
  nuget: 'NuGet',
  manual: 'Manual'
}

const AUTO_KINDS = new Set<InstallKind>(['npm', 'pypi', 'docker', 'remote', 'nuget'])

/** Options Claude Setup can set up by itself (same rule as the core). */
export function isAutoOption(option: InstallOption): boolean {
  return AUTO_KINDS.has(option.kind) || ((option.kind === 'binary' || option.kind === 'manual') && !!option.command)
}

/** The option the core uses when none is chosen. */
export function defaultOption(server: CatalogServer): InstallOption | undefined {
  return server.install.find(isAutoOption) ?? server.install[0]
}

/** Can Claude Setup add this server without manual steps? */
export function isInstallable(server: CatalogServer): boolean {
  return server.install.some(isAutoOption)
}

/** Does this option need a key or token before it works? */
export function optionNeedsKey(option: InstallOption): boolean {
  const required = (spec: { required: boolean; secret: boolean; default?: string }): boolean => spec.required && spec.secret && !spec.default
  return option.env.some(required) || (option.headers ?? []).some(required)
}

/** True when every way to run the server needs a key or token. */
export function serverNeedsKey(server: CatalogServer): boolean {
  return server.install.length > 0 && server.install.every(optionNeedsKey)
}

/** Can it run online (nothing installed on this computer)? */
export function hasRemoteOption(server: CatalogServer): boolean {
  return server.install.some((o) => o.kind === 'remote')
}

/** How an option runs, in plain words. */
export function optionTitle(option: InstallOption): string {
  switch (option.kind) {
    case 'remote':
      return 'Online — nothing to install'
    case 'npm':
      return 'On your computer (Node.js)'
    case 'pypi':
      return 'On your computer (Python)'
    case 'docker':
      return 'In a Docker container'
    case 'nuget':
      return 'On your computer (.NET)'
    case 'binary':
      return 'A program on your computer'
    case 'mcpb':
      return 'Claude Desktop extension'
    case 'manual':
      return 'Manual setup'
  }
}

/** One friendly sentence about what an option needs. */
export function optionRequirement(option: InstallOption): string {
  switch (option.runtime) {
    case 'none':
      return option.kind === 'remote' ? 'Runs on the provider’s servers — nothing to download.' : 'Nothing extra to install.'
    case 'node':
      return 'Needs Node.js on this computer. Claude Setup can install it for you.'
    case 'uv':
      return 'Needs uv (for Python tools). Claude Setup can install it for you.'
    case 'python':
      return 'Needs Python on this computer.'
    case 'docker':
      return 'Needs Docker Desktop installed and running.'
    case 'dotnet':
      return 'Needs the .NET SDK on this computer.'
  }
}

/** Transport in words (Advanced). */
export function transportLabel(transport: InstallOption['transport']): string {
  if (transport === 'http') return 'Streamable HTTP'
  if (transport === 'sse') return 'SSE'
  return 'stdio'
}

/** Package (with version) or endpoint of an option, for Advanced details. */
export function optionTarget(option: InstallOption): string | undefined {
  if (option.kind === 'remote') return option.url
  if (option.command) return [option.command, ...(option.args ?? [])].join(' ')
  if (!option.package) return undefined
  if (!option.version || option.version === 'latest') return option.package
  return option.kind === 'docker' ? `${option.package}:${option.version}` : `${option.package}@${option.version}`
}

/** Label for an option picker, e.g. "Node.js (npx) · npm · stdio". */
export function optionSelectLabel(option: InstallOption): string {
  return `${option.label} · ${KIND_LABELS[option.kind]} · ${transportLabel(option.transport)}`
}

/** Has this option anything for the user to fill in? */
export function optionHasInputs(option: InstallOption): boolean {
  return option.env.length > 0 || (option.headers?.length ?? 0) > 0 || (option.argsSpec?.length ?? 0) > 0
}

/** Number of values the user must provide (required, without a default). */
export function requiredInputCount(option: InstallOption): number {
  const specs = [...option.env, ...(option.headers ?? []), ...(option.argsSpec ?? [])]
  return specs.filter((s) => s.required && !s.default).length
}
