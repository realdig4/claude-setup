/**
 * GitHub access for installing skills, agents and hooks.
 * - Listings use the git trees API (one call per folder; optional token for higher rate limits).
 * - File contents come from raw.githubusercontent.com (not counted against the API limit).
 * - Every download is size-capped while streaming. Nothing downloaded is ever executed.
 */
import type { CoreContext } from '../context'
import { USER_AGENT } from '../http'
import { errorMessage } from './util'

export const GITHUB_API = 'https://api.github.com'
export const RAW_HOST = 'https://raw.githubusercontent.com'

export type GitHubErrorKind = 'rate-limit' | 'not-found' | 'network' | 'too-large' | 'auth' | 'http'

/** Typed failure so callers can show a friendly message. */
export class GitHubError extends Error {
  constructor(
    readonly kind: GitHubErrorKind,
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

/** One file in a repository listing. */
export interface RepoBlob {
  /** Repo-relative path with forward slashes. */
  path: string
  size: number
  executable: boolean
}

export interface RepoListing {
  blobs: RepoBlob[]
  /** GitHub cut the listing short (very large repositories). */
  truncated: boolean
}

interface TreeResponse {
  sha?: string
  truncated?: boolean
  tree?: Array<{ path: string; mode: string; type: string; size?: number }>
}

/** Encode each path segment for use in a URL. */
export function encodeRepoPath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/')
}

/** https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<path> */
export function rawUrl(owner: string, repo: string, path: string, ref = 'HEAD'): string {
  return `${RAW_HOST}/${owner}/${repo}/${encodeURIComponent(ref)}/${encodeRepoPath(path)}`
}

/** Browser URL of a folder (or the repo root). */
export function githubTreeUrl(owner: string, repo: string, path?: string): string {
  return `https://github.com/${owner}/${repo}` + (path ? `/tree/HEAD/${encodeRepoPath(path)}` : '')
}

/** Browser URL of a file. */
export function githubBlobUrl(owner: string, repo: string, path: string): string {
  return `https://github.com/${owner}/${repo}/blob/HEAD/${encodeRepoPath(path)}`
}

/** Optional token from settings.githubTokenRef (raises the API limit from 60 to 5,000 requests per hour). */
export async function githubToken(ctx: CoreContext): Promise<string | undefined> {
  const ref = ctx.state.settings().githubTokenRef
  if (!ref) return undefined
  try {
    return (await ctx.secrets.get(ref))?.trim() || undefined
  } catch {
    return undefined
  }
}

export interface BufferResponse {
  ok: boolean
  status: number
  body: Buffer
  headers: Headers
}

/** GET a URL into a Buffer, enforcing a timeout and a size cap while streaming. */
export async function fetchBuffer(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number } = {}
): Promise<BufferResponse> {
  const controller = new AbortController()
  const timeoutMs = opts.timeoutMs ?? 30_000
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const max = opts.maxBytes ?? 50 * 1024 * 1024
  try {
    let res: Response
    try {
      const headers = { 'user-agent': USER_AGENT, ...(opts.headers ?? {}) }
      res = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' })
    } catch (err) {
      throw networkError(err, url)
    }
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > max) {
      controller.abort()
      throw new GitHubError('too-large', `${formatBytes(declared)} is over the ${formatBytes(max)} limit`)
    }
    const chunks: Buffer[] = []
    let total = 0
    if (res.body) {
      const reader = res.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > max) {
            await reader.cancel().catch(() => {})
            throw new GitHubError('too-large', `more than ${formatBytes(max)}`)
          }
          chunks.push(Buffer.from(value))
        }
      } catch (err) {
        if (err instanceof GitHubError) throw err
        throw networkError(err, url)
      }
    }
    return { ok: res.ok, status: res.status, body: Buffer.concat(chunks), headers: res.headers }
  } finally {
    clearTimeout(timer)
  }
}

function networkError(err: unknown, url: string): GitHubError {
  const e = err as Error & { cause?: Error }
  if (e?.name === 'AbortError') return new GitHubError('network', `timed out while downloading ${url}`)
  return new GitHubError('network', `${errorMessage(err)}${e?.cause?.message ? ` (${e.cause.message})` : ''}`)
}

function httpError(status: number, headers: Headers, text: string): GitHubError {
  if ((status === 403 || status === 429) && (headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(text) || status === 429)) {
    return new GitHubError('rate-limit', 'GitHub rate limit reached', status)
  }
  if (status === 404) return new GitHubError('not-found', 'not found on GitHub', status)
  if (status === 401) return new GitHubError('auth', 'GitHub rejected the saved token', status)
  return new GitHubError('http', `GitHub returned HTTP ${status}`, status)
}

/** Human-readable size. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function apiGet<T>(ctx: CoreContext, path: string): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
  const token = await githubToken(ctx)
  if (token) headers.authorization = `Bearer ${token}`
  const r = await fetchBuffer(`${GITHUB_API}${path}`, { headers, timeoutMs: 30_000, maxBytes: 25 * 1024 * 1024 })
  const text = r.body.toString('utf8')
  if (!r.ok) throw httpError(r.status, r.headers, text)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new GitHubError('http', 'GitHub sent a response Claude Setup could not read')
  }
}

function toBlobs(tree: TreeResponse['tree'], prefix = ''): RepoBlob[] {
  if (!Array.isArray(tree)) return []
  return tree
    .filter((e) => e && e.type === 'blob' && typeof e.path === 'string' && e.mode !== '120000')
    .map((e) => ({ path: prefix + e.path, size: typeof e.size === 'number' ? e.size : 0, executable: e.mode === '100755' }))
}

/** Every file in a repository (default branch). */
export async function listTree(ctx: CoreContext, owner: string, repo: string, treeish = 'HEAD'): Promise<RepoListing> {
  const data = await apiGet<TreeResponse>(ctx, `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(treeish)}?recursive=1`)
  return { blobs: toBlobs(data.tree), truncated: !!data.truncated }
}

/**
 * Every file below `dir` ('' = whole repository). Looks up the folder's own tree first (two small requests)
 * and falls back to the full tree, then to the contents API for huge repositories.
 */
export async function listDirectory(ctx: CoreContext, owner: string, repo: string, dir: string): Promise<RepoListing> {
  const clean = dir.replace(/^\/+|\/+$/g, '')
  if (!clean) return listTree(ctx, owner, repo)
  const slash = clean.lastIndexOf('/')
  const parent = slash >= 0 ? clean.slice(0, slash) : ''
  const base = clean.slice(slash + 1)
  let sha: string | undefined
  try {
    const listing = await apiGet<unknown>(ctx, `/repos/${owner}/${repo}/contents${parent ? '/' + encodeRepoPath(parent) : ''}?ref=HEAD`)
    if (Array.isArray(listing)) {
      const hit = listing.find((e: { name?: string; type?: string }) => e?.name === base && e?.type === 'dir') as { sha?: string } | undefined
      sha = hit?.sha
    }
  } catch (err) {
    if (err instanceof GitHubError && (err.kind === 'rate-limit' || err.kind === 'network' || err.kind === 'auth')) throw err
  }
  if (sha) {
    const sub = await apiGet<TreeResponse>(ctx, `/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`)
    if (!sub.truncated) return { blobs: toBlobs(sub.tree, clean + '/'), truncated: false }
  }
  const full = await listTree(ctx, owner, repo)
  const blobs = full.blobs.filter((b) => b.path.startsWith(clean + '/'))
  if (blobs.length || !full.truncated) return { blobs, truncated: false }
  return listViaContents(ctx, owner, repo, clean)
}

/** Recursive contents-API listing (bounded) for repositories whose tree is too big to list at once. */
async function listViaContents(ctx: CoreContext, owner: string, repo: string, dir: string): Promise<RepoListing> {
  const blobs: RepoBlob[] = []
  const queue = [dir]
  let requests = 0
  while (queue.length && requests < 40 && blobs.length <= 400) {
    const current = queue.shift() as string
    requests++
    const entries = await apiGet<unknown>(ctx, `/repos/${owner}/${repo}/contents/${encodeRepoPath(current)}?ref=HEAD`)
    if (!Array.isArray(entries)) continue
    for (const e of entries as Array<{ path?: string; type?: string; size?: number }>) {
      if (!e?.path) continue
      if (e.type === 'file') blobs.push({ path: e.path, size: e.size ?? 0, executable: false })
      else if (e.type === 'dir') queue.push(e.path)
    }
  }
  return { blobs, truncated: queue.length > 0 }
}

/** Download one file from raw.githubusercontent.com. */
export async function downloadRepoFile(
  owner: string,
  repo: string,
  path: string,
  opts: { ref?: string; maxBytes?: number; timeoutMs?: number } = {}
): Promise<Buffer> {
  const r = await fetchBuffer(rawUrl(owner, repo, path, opts.ref), {
    maxBytes: opts.maxBytes ?? 20 * 1024 * 1024,
    timeoutMs: opts.timeoutMs ?? 60_000
  })
  if (!r.ok) throw httpError(r.status, r.headers, '')
  return r.body
}

/** Text of a repository file, trying the main, master and default branches in turn. */
export async function fetchRepoText(owner: string, repo: string, path: string, opts: { maxBytes?: number } = {}): Promise<string> {
  let last: unknown
  for (const ref of ['main', 'master', 'HEAD']) {
    try {
      return (await downloadRepoFile(owner, repo, path, { ref, maxBytes: opts.maxBytes })).toString('utf8')
    } catch (err) {
      last = err
      if (!(err instanceof GitHubError) || err.kind !== 'not-found') throw err
    }
  }
  throw last
}

/** Friendly sentence for a failed GitHub operation. */
export function friendlyGitHubError(err: unknown, what = 'the files'): string {
  if (err instanceof GitHubError) {
    switch (err.kind) {
      case 'rate-limit':
        return "GitHub's download limit was reached (60 requests per hour without a token). Wait a little while, or add a GitHub token in Settings to raise the limit."
      case 'not-found':
        return `Couldn't find ${what} on GitHub. It may have been moved, renamed or deleted.`
      case 'network':
        return `Couldn't reach GitHub. Check your internet connection and try again (${err.message}).`
      case 'too-large':
        return `${capitalize(what)} is too large to install safely (${err.message}).`
      case 'auth':
        return 'GitHub rejected the GitHub token saved in Settings. It may have expired — update or remove it and try again.'
      default:
        return `GitHub couldn't provide ${what} (${err.message}).`
    }
  }
  return `Download failed: ${errorMessage(err)}`
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
