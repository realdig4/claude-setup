/**
 * aitmpl.com — Claude Code Templates (github.com/davila7/claude-code-templates).
 *   GET https://aitmpl.com/components.json  (~2.3 MB; keys agents, commands, hooks, settings, skills, …)
 *   record: { name, path, category, type, description, author, downloads, keywords, skillspector{score,severity,recommendation,findings[]} }
 * Files: raw.githubusercontent.com/davila7/claude-code-templates/main/cli-tool/components/<section>/<path>.
 * We use agents, commands, hooks, status lines (settings/statusline/*), skills and output styles (when published).
 */
import type { ExtensionKind } from '@shared/types'
import { isPlainObject } from '../../fs/json'
import { fetchJson } from '../../http'
import { githubBlobUrl, githubTreeUrl } from '../github'
import { catalogItemId, isSafeRelativePath } from '../ids'
import type { CatalogItem } from '../types'
import { clip, looseSlug } from '../util'

export const AITMPL_URL = 'https://aitmpl.com/components.json'
export const AITMPL_OWNER = 'davila7'
export const AITMPL_REPO = 'claude-code-templates'
export const AITMPL_BASE = 'cli-tool/components'

interface Section {
  keys: string[]
  kind: ExtensionKind
  dir: string
  accept: (path: string) => boolean
}

const SECTIONS: Section[] = [
  { keys: ['agents'], kind: 'agent', dir: 'agents', accept: (p) => p.endsWith('.md') },
  { keys: ['commands'], kind: 'command', dir: 'commands', accept: (p) => p.endsWith('.md') },
  { keys: ['hooks'], kind: 'hook', dir: 'hooks', accept: (p) => p.endsWith('.json') },
  { keys: ['settings'], kind: 'statusline', dir: 'settings', accept: (p) => p.startsWith('statusline/') && p.endsWith('.json') },
  { keys: ['skills'], kind: 'skill', dir: 'skills', accept: (p) => !/\.(md|json)$/i.test(p) },
  { keys: ['outputStyles', 'output-styles', 'output_styles', 'outputstyles'], kind: 'output-style', dir: 'output-styles', accept: (p) => p.endsWith('.md') }
]

/** Standing warning for kinds that run commands. */
export function runsCommandsWarning(kind: ExtensionKind): string | undefined {
  if (kind === 'hook') {
    return (
      'Hooks run commands on your computer automatically when Claude Code does things (edits files, runs tools, starts a session). ' +
      'Only install hooks you trust.'
    )
  }
  if (kind === 'statusline') return 'A status line runs a command on your computer every time the Claude Code status bar refreshes.'
  return undefined
}

const SEVERITY_ORDER: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }

/** Turn an aitmpl SkillSpector security report into short warnings. */
export function skillspectorWarnings(report: unknown): string[] {
  if (!isPlainObject(report)) return []
  const recommendation = String(report.recommendation ?? '').toUpperCase()
  const severity = String(report.severity ?? '').toUpperCase()
  const score = typeof report.score === 'number' ? ` (risk score ${report.score}/100)` : ''
  const findings = Array.isArray(report.findings) ? report.findings.filter(isPlainObject) : []
  const out: string[] = []
  if (recommendation === 'DO_NOT_INSTALL') out.push(`Security scan (SkillSpector) advises NOT installing this: ${severity.toLowerCase() || 'high'} risk${score}.`)
  else if (recommendation === 'CAUTION') {
    out.push(
      findings.length
        ? `Security scan (SkillSpector) suggests caution: ${severity.toLowerCase() || 'some'} risk${score}.`
        : 'Security scan (SkillSpector) could only partly check this. Review it before installing.'
    )
  } else if (findings.length && (severity === 'HIGH' || severity === 'CRITICAL')) {
    out.push(`Security scan (SkillSpector) found ${severity.toLowerCase()} risk issues${score}.`)
  }
  if (out.length) {
    const rank = (f: Record<string, unknown>) => SEVERITY_ORDER[String(f.severity).toUpperCase()] ?? 9
    const sorted = [...findings].sort((a, b) => rank(a) - rank(b))
    for (const f of sorted.slice(0, 3)) {
      const title = typeof f.title === 'string' ? clip(f.title, 140) : 'Issue'
      const parts = [typeof f.category === 'string' ? f.category : '', typeof f.severity === 'string' ? f.severity.toLowerCase() : ''].filter(Boolean)
      const where = typeof f.file === 'string' ? ` in ${f.file}${typeof f.line === 'number' ? `:${f.line}` : ''}` : ''
      out.push(`${title}${parts.length ? ` (${parts.join(', ')})` : ''}${where}`)
    }
    if (sorted.length > 3) out.push(`…and ${sorted.length - 3} more finding${sorted.length - 3 === 1 ? '' : 's'}.`)
  }
  return out
}

/** Agent descriptions embed long <example> blocks; keep the first, readable part. */
export function cleanDescription(text: unknown): string {
  if (typeof text !== 'string') return ''
  let t = text.replace(/\r/g, '').replace(/\\n/g, '\n')
  const cut = t.search(/<example>|\n\s*examples?\s*:/i)
  if (cut > 40) t = t.slice(0, cut)
  t = t.replace(/<\/?[a-z][^>]*>/gi, ' ')
  return clip(t, 420)
}

/** Parse components.json into catalog items. */
export function parseAitmplComponents(json: unknown): CatalogItem[] {
  if (!isPlainObject(json)) throw new Error('aitmpl.com returned an unexpected catalog format')
  const out: CatalogItem[] = []
  const seen = new Set<string>()
  for (const section of SECTIONS) {
    const key = section.keys.find((k) => Array.isArray(json[k]))
    if (!key) continue
    for (const rec of json[key] as unknown[]) {
      if (!isPlainObject(rec) || typeof rec.name !== 'string' || typeof rec.path !== 'string') continue
      const path = rec.path.replace(/^\/+/, '')
      if (!isSafeRelativePath(path) || !section.accept(path)) continue
      const fullPath = `${AITMPL_BASE}/${section.dir}/${path}`
      const id = catalogItemId(section.kind, 'aitmpl', AITMPL_OWNER, AITMPL_REPO, fullPath)
      if (seen.has(id)) continue
      seen.add(id)
      const warnings = [runsCommandsWarning(section.kind), ...skillspectorWarnings(rec.skillspector)].filter((w): w is string => !!w)
      const keywords = Array.isArray(rec.keywords) ? rec.keywords.filter((k): k is string => typeof k === 'string').slice(0, 12) : undefined
      out.push({
        id,
        kind: section.kind,
        name: rec.name,
        description: cleanDescription(rec.description),
        author: typeof rec.author === 'string' && rec.author.trim() ? rec.author.trim() : undefined,
        source: 'aitmpl',
        repo: `${AITMPL_OWNER}/${AITMPL_REPO}`,
        path: fullPath,
        url: section.kind === 'skill' ? githubTreeUrl(AITMPL_OWNER, AITMPL_REPO, fullPath) : githubBlobUrl(AITMPL_OWNER, AITMPL_REPO, fullPath),
        category: typeof rec.category === 'string' ? rec.category : undefined,
        installs: typeof rec.downloads === 'number' && rec.downloads >= 0 ? rec.downloads : undefined,
        installed: false,
        warnings: warnings.length ? warnings : undefined,
        dedupeKey: section.kind === 'skill' ? `${AITMPL_OWNER}/${AITMPL_REPO}:${looseSlug(rec.name)}` : undefined,
        tags: keywords?.length ? keywords : undefined
      })
    }
  }
  return out
}

/** Download and parse the aitmpl catalog. */
export async function fetchAitmpl(): Promise<CatalogItem[]> {
  const r = await fetchJson<unknown>(AITMPL_URL, { timeoutMs: 60_000 })
  if (!r.ok || r.data === undefined) throw new Error(r.error ?? `aitmpl.com returned HTTP ${r.status}`)
  return parseAitmplComponents(r.data)
}
