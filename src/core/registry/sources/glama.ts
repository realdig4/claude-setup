/**
 * Glama MCP registry (optional; needs the user's Glama API key). Discovery + enrichment only: Glama
 * publishes repository URLs and env-var schemas but no launch commands. Glama's data license requires
 * visible attribution and a link to each record's Glama page — `homepage` holds that link.
 */
import type { EnvVarSpec } from '@shared/types'
import { manualOption } from '../install'
import { parseRepoUrl, repoBaseKey, repoKey } from '../keys'
import { makeServer, sourceScopedId } from '../normalize'
import type { SourceEntry } from '../types'
import { asArray, asRecord, asString, isHttpUrl, isImageUrl, plainDescription } from '../util'
import { paginateCursor, type SourceAdapter, type SourceRunContext, type SourceRunResult } from './source'

export const GLAMA_API = 'https://glama.ai/api/mcp/v1/servers'
export const GLAMA_ATTRIBUTION = 'MCP data from Glama (glama.ai)'

function envFromSchema(schema: unknown): EnvVarSpec[] {
  const s = asRecord(schema)
  const props = asRecord(s?.properties)
  if (!props) return []
  const required = new Set(asArray(s?.required).filter((r): r is string => typeof r === 'string'))
  return Object.entries(props)
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, v]) => {
      const p = asRecord(v) ?? {}
      return {
        name,
        description: plainDescription(p.description, 300) || undefined,
        required: required.has(name),
        secret: /key|token|secret|password|credential/i.test(name),
        default: asString(p.default)
      }
    })
}

/** Parse one Glama server object. */
export function parseGlamaItem(raw: unknown): SourceEntry | undefined {
  const it = asRecord(raw)
  const namespace = asString(it?.namespace)
  const slug = asString(it?.slug)
  if (!it || !namespace || !slug) return undefined
  const repoUrl = asString(asRecord(it.repository)?.url)
  const repo = parseRepoUrl(repoUrl)
  const listing = asString(it.url) ?? `https://glama.ai/mcp/servers/${namespace}/${slug}`
  const thumb = asString(it.thumbnailUrl)
  const attributes = asArray(it.attributes).filter((a): a is string => typeof a === 'string')
  const name = asString(it.name)
  return {
    source: 'glama',
    sourceId: `${namespace}/${slug}`,
    keys: repo ? [repoKey(repo)] : [],
    softKeys: repo ? [repoBaseKey(repo)] : [],
    nameExplicit: !!name || undefined,
    server: makeServer('glama', {
      id: sourceScopedId('glama', `${namespace}/${slug}`),
      name: name ?? slug,
      description: plainDescription(it.description, 400),
      publisher: namespace,
      repository: isHttpUrl(repoUrl) ? repoUrl : undefined,
      homepage: listing,
      iconUrl: isImageUrl(thumb) ? thumb : undefined,
      official: attributes.some((a) => /official/i.test(a)) || undefined,
      tags: attributes.map((a) => a.split(':').pop()),
      install: [
        manualOption({
          notes: `${GLAMA_ATTRIBUTION}. See the project's README for setup instructions.`,
          url: isHttpUrl(repoUrl) ? repoUrl : listing,
          env: envFromSchema(it.environmentVariablesJsonSchema)
        })
      ]
    })
  }
}

/** Parse a list page. */
export function parseGlamaPage(raw: unknown): { entries: SourceEntry[]; items: number; next?: string } {
  const page = asRecord(raw)
  const info = asRecord(page?.pageInfo)
  const items = asArray(page?.servers)
  return {
    entries: items.map(parseGlamaItem).filter((e): e is SourceEntry => !!e),
    items: items.length,
    next: info?.hasNextPage === true ? asString(info.endCursor) : undefined
  }
}

async function run(rc: SourceRunContext): Promise<SourceRunResult> {
  const key = await rc.secret(rc.settings.glamaKeyRef)
  if (!key) throw new Error('Add your Glama API key in Settings to use this source.')
  const headers = { authorization: `Bearer ${key}` }
  const sink = rc.begin('replace')
  let count = 0
  const pages = paginateCursor(async (cursor) => {
    const url = `${GLAMA_API}?first=100&sort=added-at%3Adesc${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`
    const page = parseGlamaPage(await rc.http.json(url, headers))
    return { items: page.items ? [page] : [], next: page.next }
  })
  for await (const [page] of pages) {
    await sink.put(page.entries)
    count += page.entries.length
    rc.progress(count, `Glama: ${count.toLocaleString('en-US')} servers…`)
  }
  if (!count) throw new Error('Glama returned no servers.')
  return { message: `${count.toLocaleString('en-US')} servers` }
}

export const glamaSource: SourceAdapter = {
  id: 'glama',
  label: 'Glama',
  heavy: true,
  minTtlHours: 24 * 7,
  http: { concurrency: 1, minIntervalMs: 100, timeoutMs: 60_000 },
  available: async (rc) => !!rc.settings.glamaKeyRef && !!(await rc.secret(rc.settings.glamaKeyRef)),
  run
}
