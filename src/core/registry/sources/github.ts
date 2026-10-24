/**
 * GitHub MCP Registry (github.com/mcp, api.mcp.github.com): curated server.json entries plus GitHub
 * repository data (stars, topics, license, owner avatar). Every entry ships its full README; only a
 * short excerpt is kept.
 */
import { nameKey } from '../keys'
import type { SourceEntry } from '../types'
import { asArray, asRecord, asString, isHttpUrl, readmeExcerpt, toCount } from '../util'
import { officialMeta, serverJsonEntry } from './common'
import { paginateCursor, type SourceAdapter, type SourceRunContext, type SourceRunResult } from './source'

export const GITHUB_API = 'https://api.mcp.github.com/v0.1/servers'

/** Append the license line to a description excerpt. */
export function withLicense(text: string | undefined, license: string | undefined): string | undefined {
  if (!license) return text
  return text ? `${text}\n\nLicense: ${license}` : `License: ${license}`
}

/** New-style registry names ("io.github.owner/name") are official registry names. */
function isRegistryName(name: string): boolean {
  return /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+\/[a-zA-Z0-9._-]+$/.test(name)
}

/** Parse one list item of the GitHub registry. */
export function parseGithubItem(raw: unknown): SourceEntry | undefined {
  const item = asRecord(raw)
  const server = asRecord(item?.server)
  const name = asString(server?.name)
  if (!item || !server || !name) return undefined
  const status = officialMeta(item).status
  if (status === 'deleted') return undefined
  const gh = asRecord(asRecord(asRecord(server._meta)?.['io.modelcontextprotocol.registry/publisher-provided'])?.github) ?? {}
  const nameWithOwner = asString(gh.nameWithOwner)
  const owner = nameWithOwner?.split('/')[0]
  const repoUrl = asString(asRecord(server.repository)?.url) ?? (nameWithOwner ? `https://github.com/${nameWithOwner}` : undefined)
  const registryName = isRegistryName(name)
  const nsOwner = name.split('/')[0].replace(/^io\.github\./i, '').toLowerCase()
  const official = registryName
    ? undefined
    : gh.isInOrganization === true && !!owner && owner.toLowerCase() === nsOwner
  const homepage = asString(gh.homepageUrl)
  const entry = serverJsonEntry('github', server, {
    guard: registryName,
    name: asString(gh.displayName) ?? asString(server.title),
    longDescription: withLicense(readmeExcerpt(gh.readme, 500), asString(gh.license)),
    publisher: owner,
    repository: repoUrl?.replace(/\.git$/, ''),
    homepage: isHttpUrl(homepage) ? homepage : undefined,
    iconUrl: asString(gh.ownerAvatarUrl),
    tags: [...asArray(gh.topics).filter((t): t is string => typeof t === 'string'), asString(gh.primaryLanguage)?.toLowerCase()],
    official,
    verified: true,
    stars: toCount(gh.stargazerCount),
    metrics: { stars: toCount(gh.stargazerCount) },
    updatedAt: asString(gh.pushedAt) ?? officialMeta(item).updatedAt
  })
  if (entry && !registryName) entry.keys = entry.keys.filter((k) => k !== nameKey(name))
  return entry
}

/** Parse a list page. */
export function parseGithubPage(raw: unknown): { entries: SourceEntry[]; items: number; next?: string; total?: number } {
  const page = asRecord(raw)
  const items = asArray(page?.servers)
  const meta = asRecord(page?.metadata)
  return {
    entries: items.map(parseGithubItem).filter((e): e is SourceEntry => !!e),
    items: items.length,
    next: asString(meta?.nextCursor),
    total: toCount(meta?.total)
  }
}

async function run(rc: SourceRunContext): Promise<SourceRunResult> {
  const sink = rc.begin('replace')
  let count = 0
  let total: number | undefined
  const pages = paginateCursor(async (cursor) => {
    const url = `${GITHUB_API}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    const page = parseGithubPage(await rc.http.json(url))
    total ??= page.total
    return { items: page.items ? [page] : [], next: page.next }
  }, 200)
  for await (const [page] of pages) {
    await sink.put(page.entries)
    count += page.entries.length
    rc.progress(count, `GitHub MCP registry: ${count}${total ? ` of ${total}` : ''} servers…`)
  }
  if (!count) throw new Error('The GitHub MCP registry returned no servers.')
  return { message: `${count} servers` }
}

export const githubSource: SourceAdapter = {
  id: 'github',
  label: 'GitHub MCP registry',
  heavy: false,
  http: { concurrency: 1, minIntervalMs: 300, timeoutMs: 90_000 },
  available: async () => true,
  run
}
