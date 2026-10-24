/**
 * punkpeye/awesome-mcp-servers README (~4,600 entries). Discovery only: each entry becomes a
 * "manual" install option linking to the repository; entries known to a registry merge into it.
 */
import { manualOption } from '../install'
import { parseRepoUrl, repoBaseKey, repoKey } from '../keys'
import { ARCHIVED_NOTE, isArchivedReference, makeServer, sourceScopedId } from '../normalize'
import type { SourceEntry } from '../types'
import { cleanText, plainDescription, prettifyName } from '../util'
import type { SourceAdapter, SourceRunContext, SourceRunResult } from './source'

export const AWESOME_README_URL = 'https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/main/README.md'

const ENTRY_RE = /^\s*[-*]\s+\[(?<label>[^\]]+)\]\((?<url>https?:\/\/[^)\s]+)\)(?<rest>.*)$/
const BADGE_RE = /\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g
const HEADING_RE = /^###\s+(.*)$/

const LANGUAGES: Array<[string, string]> = [
  ['🐍', 'python'],
  ['📇', 'typescript'],
  ['🏎️', 'go'],
  ['🦀', 'rust'],
  ['#️⃣', 'csharp'],
  ['☕', 'java'],
  ['🌊', 'cpp'],
  ['💎', 'ruby']
]

function headingLabel(raw: string): string {
  return cleanText(raw.replace(/<a[^>]*>\s*<\/a>/gi, '').replace(/<[^>]+>/g, '').replace(/^[^\p{L}\p{N}]+/u, ''))
}

/** Parse the README markdown (region between "## Server Implementations" and the next "## " heading). */
export function parseAwesomeReadme(markdown: string): SourceEntry[] {
  const lines = markdown.split(/\r?\n/)
  let start = lines.findIndex((l) => /^##\s+Server Implementations/i.test(l))
  if (start < 0) start = 0
  const out: SourceEntry[] = []
  const seen = new Set<string>()
  let category = ''
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s+/.test(line)) break
    const h = HEADING_RE.exec(line)
    if (h) {
      category = headingLabel(h[1])
      continue
    }
    const m = ENTRY_RE.exec(line)
    if (!m?.groups) continue
    const repo = parseRepoUrl(m.groups.url)
    if (!repo) continue
    const sourceId = repoKey(repo).slice('repo:'.length)
    if (seen.has(sourceId)) continue
    seen.add(sourceId)
    const rest = m.groups.rest.replace(BADGE_RE, ' ')
    const dash = rest.search(/\s[-–—]\s/)
    const markers = dash >= 0 ? rest.slice(0, dash) : rest
    const description = plainDescription(dash >= 0 ? rest.slice(dash + 3) : '', 400)
    const tags: string[] = []
    for (const [emoji, lang] of LANGUAGES) if (markers.includes(emoji)) tags.push(lang)
    if (markers.includes('☁️')) tags.push('cloud')
    if (markers.includes('🏠')) tags.push('local')
    if (markers.includes('📟')) tags.push('embedded')
    const label = cleanText(m.groups.label).replace(/^@/, '')
    const name = /^[\w.-]+\/[\w.-]+$/.test(label) ? prettifyName(label.split('/')[1]) : label
    out.push({
      source: 'awesome',
      ...(isArchivedReference(repo) ? { deprecated: ARCHIVED_NOTE } : {}),
      sourceId,
      keys: [repoKey(repo)],
      softKeys: [repoBaseKey(repo)],
      nameExplicit: !/^[\w.-]+\/[\w.-]+$/.test(label) || undefined,
      server: makeServer('awesome', {
        id: sourceScopedId('awesome', sourceId),
        name,
        description,
        publisher: repo.owner,
        repository: m.groups.url,
        sourceCategories: category ? [category] : undefined,
        tags,
        official: markers.includes('🎖'),
        install: [manualOption({ notes: "See the project's README for setup instructions.", url: m.groups.url })]
      })
    })
  }
  return out
}

async function run(rc: SourceRunContext): Promise<SourceRunResult> {
  const res = await rc.http.text(AWESOME_README_URL, { accept: 'text/plain, text/markdown, */*' })
  const entries = parseAwesomeReadme(res.text)
  if (!entries.length) throw new Error('The awesome-mcp-servers list could not be read.')
  const sink = rc.begin('replace')
  await sink.put(entries)
  rc.progress(entries.length, `awesome-mcp-servers: ${entries.length} servers`)
  return { message: `${entries.length} servers` }
}

export const awesomeSource: SourceAdapter = {
  id: 'awesome',
  label: 'awesome-mcp-servers list',
  heavy: false,
  minTtlHours: 24 * 7,
  http: { concurrency: 1, minIntervalMs: 0, timeoutMs: 60_000 },
  available: async () => true,
  run
}
