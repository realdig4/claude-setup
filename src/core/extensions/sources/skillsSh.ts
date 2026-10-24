/**
 * skills.sh (Vercel's skills directory) — query-driven search, no auth.
 *   GET https://skills.sh/api/search?q=<q>&limit=<n>   (q must be at least 2 characters)
 *   → { skills: [{ id: "owner/repo/skillId", source: "owner/repo", skillId, name, installs }] }
 * Results carry no description and no folder path; the folder is located in the repo at install time.
 */
import { isPlainObject } from '../../fs/json'
import { fetchJson } from '../../http'
import { catalogItemId } from '../ids'
import type { CatalogItem } from '../types'
import { looseSlug } from '../util'
import { parseGitHubRepo } from './marketplaces'

export const SKILLS_SH_SEARCH = 'https://skills.sh/api/search'

/** Parse a skills.sh search response. */
export function parseSkillsShResults(json: unknown): CatalogItem[] {
  const list: unknown[] = isPlainObject(json) && Array.isArray(json.skills) ? json.skills : []
  const out: CatalogItem[] = []
  const seen = new Set<string>()
  for (const s of list) {
    if (!isPlainObject(s) || typeof s.source !== 'string' || typeof s.skillId !== 'string') continue
    const gh = parseGitHubRepo(s.source)
    const skillId = s.skillId.trim()
    if (!gh || !skillId || skillId.includes('/') || skillId.includes('\\') || skillId === '.' || skillId === '..') continue
    const id = catalogItemId('skill', 'skills.sh', gh.owner, gh.repo, skillId)
    if (seen.has(id)) continue
    seen.add(id)
    const name = typeof s.name === 'string' && s.name.trim() ? s.name.trim() : skillId
    const pageId = typeof s.id === 'string' && /^[\w.-]+\/[\w.-]+\/[^/]+$/.test(s.id) ? s.id : `${gh.owner}/${gh.repo}/${skillId}`
    out.push({
      id,
      kind: 'skill',
      name,
      description: `Community skill published in ${gh.owner}/${gh.repo} (found on skills.sh).`,
      author: gh.owner,
      source: 'skills.sh',
      repo: `${gh.owner}/${gh.repo}`,
      url: `https://skills.sh/${pageId.split('/').map(encodeURIComponent).join('/')}`,
      installs: typeof s.installs === 'number' && s.installs >= 0 ? s.installs : undefined,
      installed: false,
      dedupeKey: `${gh.owner.toLowerCase()}/${gh.repo.toLowerCase()}:${looseSlug(skillId)}`
    })
  }
  return out
}

/** Search skills.sh. Queries shorter than 2 characters return []. Throws on network/HTTP errors. */
export async function searchSkillsSh(query: string, limit = 50): Promise<CatalogItem[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const n = Math.min(100, Math.max(1, Math.floor(limit)))
  const r = await fetchJson<unknown>(`${SKILLS_SH_SEARCH}?q=${encodeURIComponent(q)}&limit=${n}`, { timeoutMs: 15_000 })
  if (!r.ok || r.data === undefined) throw new Error(r.error ?? `skills.sh returned HTTP ${r.status}`)
  return parseSkillsShResults(r.data)
}
