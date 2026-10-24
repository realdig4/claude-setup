/**
 * Cline MCP marketplace (api.cline.bot): ~200 reviewed servers with GitHub stars and download counts.
 * No install commands — used for discovery and to enrich popularity of servers known elsewhere.
 */
import { manualOption } from '../install'
import { parseRepoUrl, repoBaseKey, repoKey } from '../keys'
import { ARCHIVED_NOTE, isArchivedReference, makeServer, sourceScopedId } from '../normalize'
import type { SourceEntry } from '../types'
import { asArray, asRecord, asString, isHttpUrl, isImageUrl, plainDescription, readmeExcerpt, toCount, toIsoDate } from '../util'
import type { SourceAdapter, SourceRunContext, SourceRunResult } from './source'

export const CLINE_API = 'https://api.cline.bot/v1/mcp/marketplace'

/** Parse one marketplace item. */
export function parseClineItem(raw: unknown): SourceEntry | undefined {
  const it = asRecord(raw)
  const mcpId = asString(it?.mcpId)
  if (!it || !mcpId) return undefined
  const githubUrl = asString(it.githubUrl)
  const repo = parseRepoUrl(githubUrl) ?? parseRepoUrl(mcpId)
  // Stars of a monorepo subfolder belong to the whole repository.
  const stars = repo?.subfolder ? undefined : toCount(it.githubStars)
  const downloads = toCount(it.downloadCount)
  const name = asString(it.name)
  const logo = asString(it.logoUrl)
  const link = isHttpUrl(githubUrl) ? githubUrl : repo ? `https://${repo.host}/${repo.owner}/${repo.repo}` : undefined
  return {
    source: 'cline',
    ...(isArchivedReference(repo) ? { deprecated: ARCHIVED_NOTE } : {}),
    sourceId: mcpId,
    keys: repo ? [repoKey(repo)] : [],
    softKeys: repo ? [repoBaseKey(repo)] : [],
    nameExplicit: !!name || undefined,
    metrics: { stars, downloads },
    server: makeServer('cline', {
      id: sourceScopedId('cline', mcpId),
      name: name ?? mcpId.split('/').pop() ?? mcpId,
      description: plainDescription(it.description, 400),
      longDescription: readmeExcerpt(it.readmeContent, 500),
      publisher: asString(it.author),
      repository: link,
      iconUrl: isImageUrl(logo) ? logo : undefined,
      sourceCategories: asString(it.category) ? [asString(it.category)!] : undefined,
      tags: asArray(it.tags).filter((t): t is string => typeof t === 'string'),
      stars,
      updatedAt: toIsoDate(it.updatedAt),
      install: [
        manualOption({
          notes: `Setup instructions are in the project's README${it.requiresApiKey === true ? ' (an API key is required)' : ''}.`,
          url: link
        })
      ]
    })
  }
}

/** Parse the marketplace array. */
export function parseClineMarketplace(raw: unknown): SourceEntry[] {
  return asArray(raw)
    .map(parseClineItem)
    .filter((e): e is SourceEntry => !!e)
}

async function run(rc: SourceRunContext): Promise<SourceRunResult> {
  const entries = parseClineMarketplace(await rc.http.json(CLINE_API))
  if (!entries.length) throw new Error('The Cline marketplace returned no servers.')
  const sink = rc.begin('replace')
  await sink.put(entries)
  rc.progress(entries.length, `Cline marketplace: ${entries.length} servers`)
  return { message: `${entries.length} servers` }
}

export const clineSource: SourceAdapter = {
  id: 'cline',
  label: 'Cline marketplace',
  heavy: false,
  http: { concurrency: 1, minIntervalMs: 0, timeoutMs: 60_000 },
  available: async () => true,
  run
}
