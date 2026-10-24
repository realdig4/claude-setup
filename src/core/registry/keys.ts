/**
 * Matching keys used to recognise the same MCP server across registries (research §12):
 *   name:<official reverse-DNS name>      exact registry name
 *   npm:<id> | pypi:<pep503> | oci:<registry/repo> | nuget:<id> | mcpb:<url>   package keys
 *   remote:<host/path>                    remote endpoint (no scheme, query, fragment, trailing slash)
 *   repo:<host/owner/repo>[#subfolder]    source repository
 */

/** Key for a registry name. */
export function nameKey(name: string): string {
  return `name:${name.trim().toLowerCase()}`
}

/** PEP 503 normalisation of a Python package name. */
export function pep503(name: string): string {
  return name.trim().replace(/[-_.]+/g, '-').toLowerCase()
}

/**
 * Normalise an OCI image reference to `registry/repo` without tag or digest:
 * "mcp/fetch@sha256:…" → "docker.io/mcp/fetch", "postgres:16" → "docker.io/library/postgres".
 */
export function normalizeOciRef(identifier: string): string {
  let ref = identifier.trim().toLowerCase().replace(/^[a-z]+:\/\//, '')
  ref = ref.replace(/@sha256:[a-f0-9]+$/, '')
  const lastSlash = ref.lastIndexOf('/')
  const lastColon = ref.lastIndexOf(':')
  if (lastColon > lastSlash) ref = ref.slice(0, lastColon)
  const parts = ref.split('/')
  const hasHost = parts.length > 1 && (parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost')
  if (!hasHost) parts.unshift('docker.io')
  if (parts[0] === 'index.docker.io' || parts[0] === 'registry-1.docker.io') parts[0] = 'docker.io'
  if (parts[0] === 'docker.io' && parts.length === 2) parts.splice(1, 0, 'library')
  return parts.join('/')
}

/** Package key for a server.json package (undefined for unknown registry types). */
export function packageKey(registryType: string, identifier: string): string | undefined {
  const id = identifier.trim()
  if (!id) return undefined
  switch (registryType.toLowerCase()) {
    case 'npm':
      return `npm:${id.toLowerCase()}`
    case 'pypi':
      return `pypi:${pep503(id)}`
    case 'oci':
    case 'docker':
      return `oci:${normalizeOciRef(id)}`
    case 'nuget':
      return `nuget:${id.toLowerCase()}`
    case 'mcpb':
      return `mcpb:${id}`
    case 'cargo':
      return `cargo:${id.toLowerCase()}`
    default:
      return undefined
  }
}

/**
 * Remote endpoint key: lowercase host + path, no scheme/query/fragment/trailing slash.
 * Returns undefined for templated URLs ("https://{host}/mcp", "{url}") or unparsable ones.
 */
export function remoteKey(url: string): string | undefined {
  if (!url || /[{}]/.test(url)) return undefined
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
    const host = u.host.toLowerCase().replace(/^www\./, '')
    const path = decodeURIComponent(u.pathname).replace(/\/+$/, '').toLowerCase()
    return `remote:${host}${path}`
  } catch {
    return undefined
  }
}

/**
 * Soft remote key: like remoteKey but with a trailing /mcp or /sse segment removed, so
 * https://x.com/mcp and https://x.com/sse can be recognised as the same service.
 */
export function softRemoteKey(url: string): string | undefined {
  const key = remoteKey(url)
  if (!key) return undefined
  return 'rhost:' + key.slice('remote:'.length).replace(/\/(mcp|sse)$/i, '')
}

export interface RepoRef {
  host: string
  owner: string
  repo: string
  subfolder?: string
}

/**
 * Parse a GitHub / GitLab repository URL (also "git+https://…", "…/tree/<ref>/<path>", "github.com/o/r").
 */
export function parseRepoUrl(url: string | undefined, subfolder?: string): RepoRef | undefined {
  if (!url) return undefined
  let s = url.trim().replace(/^git\+/, '').replace(/^git@([^:]+):/, 'https://$1/')
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return undefined
  }
  const host = u.host.toLowerCase().replace(/^www\./, '')
  if (host !== 'github.com' && host !== 'gitlab.com') return undefined
  const parts = decodeURIComponent(u.pathname).split('/').filter(Boolean)
  if (parts.length < 2) return undefined
  const owner = parts[0].toLowerCase()
  const repo = parts[1].toLowerCase().replace(/\.git$/, '')
  if (!owner || !repo) return undefined
  let sub = subfolder?.trim().replace(/^\.?\/+|\/+$/g, '') || undefined
  const treeIdx = parts.findIndex((p, i) => i >= 2 && (p === 'tree' || p === 'blob') && parts[i - 1] !== '-')
  const dashIdx = parts.indexOf('-')
  const gitlabTree = dashIdx >= 0 && (parts[dashIdx + 1] === 'tree' || parts[dashIdx + 1] === 'blob')
  const markerIdx = treeIdx >= 0 ? treeIdx : gitlabTree ? dashIdx + 1 : -1
  if (!sub && markerIdx >= 0 && parts.length > markerIdx + 2) sub = parts.slice(markerIdx + 2).join('/')
  return { host, owner, repo, subfolder: sub ? sub.toLowerCase() : undefined }
}

/** Repo key without subfolder: repo:github.com/owner/repo */
export function repoBaseKey(ref: RepoRef): string {
  return `repo:${ref.host}/${ref.owner}/${ref.repo}`
}

/** Repo key including the subfolder (when any): repo:github.com/owner/repo#packages/x */
export function repoKey(ref: RepoRef): string {
  return ref.subfolder ? `${repoBaseKey(ref)}#${ref.subfolder}` : repoBaseKey(ref)
}

/** Canonical https URL of a repository reference (no subfolder). */
export function repoUrl(ref: RepoRef): string {
  return `https://${ref.host}/${ref.owner}/${ref.repo}`
}
