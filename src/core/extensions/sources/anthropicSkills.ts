/**
 * Anthropic's own Agent Skills (github.com/anthropics/skills). The skill folders come from the repo's
 * .claude-plugin/marketplace.json (plugins[].skills such as "./skills/pdf"); name and description come
 * from each SKILL.md frontmatter.
 */
import { isPlainObject } from '../../fs/json'
import { parseFrontmatter, fmString } from '../frontmatter'
import { downloadRepoFile, fetchRepoText, githubTreeUrl } from '../github'
import { catalogItemId, isSafeRelativePath } from '../ids'
import type { CatalogItem } from '../types'
import { clip, looseSlug, mapLimit } from '../util'

export const ANTHROPIC_SKILLS_OWNER = 'anthropics'
export const ANTHROPIC_SKILLS_REPO = 'skills'

export interface AnthropicSkillEntry {
  /** Folder inside the repo, e.g. "skills/pdf". */
  path: string
  /** Plugin that bundles it, e.g. "document-skills". */
  group: string
  groupDescription?: string
}

/** Skill folders listed by the repo's marketplace.json. */
export function skillPathsFromMarketplace(json: unknown): AnthropicSkillEntry[] {
  if (!isPlainObject(json) || !Array.isArray(json.plugins)) return []
  const out: AnthropicSkillEntry[] = []
  const seen = new Set<string>()
  for (const plugin of json.plugins) {
    if (!isPlainObject(plugin) || !Array.isArray(plugin.skills)) continue
    const group = typeof plugin.name === 'string' ? plugin.name : 'skills'
    const groupDescription = typeof plugin.description === 'string' ? plugin.description : undefined
    for (const raw of plugin.skills) {
      if (typeof raw !== 'string') continue
      const path = raw.replace(/^\.\/+/, '').replace(/\/+$/, '')
      if (!isSafeRelativePath(path) || seen.has(path)) continue
      seen.add(path)
      out.push({ path, group, groupDescription })
    }
  }
  return out
}

/** Catalog item for one Anthropic skill (frontmatter may be empty when SKILL.md could not be read). */
export function anthropicSkillItem(entry: AnthropicSkillEntry, frontmatter: Record<string, unknown>): CatalogItem {
  const folder = entry.path.slice(entry.path.lastIndexOf('/') + 1)
  return {
    id: catalogItemId('skill', 'anthropic-skills', ANTHROPIC_SKILLS_OWNER, ANTHROPIC_SKILLS_REPO, entry.path),
    kind: 'skill',
    name: fmString(frontmatter, 'name') ?? folder,
    description: clip(fmString(frontmatter, 'description') ?? entry.groupDescription ?? `Anthropic skill "${folder}".`, 600),
    author: 'Anthropic',
    source: 'anthropic-skills',
    repo: `${ANTHROPIC_SKILLS_OWNER}/${ANTHROPIC_SKILLS_REPO}`,
    path: entry.path,
    url: githubTreeUrl(ANTHROPIC_SKILLS_OWNER, ANTHROPIC_SKILLS_REPO, entry.path),
    category: entry.group,
    installed: false,
    trusted: true,
    dedupeKey: `${ANTHROPIC_SKILLS_OWNER}/${ANTHROPIC_SKILLS_REPO}:${looseSlug(folder)}`
  }
}

/** Fetch the skill list and every SKILL.md header (6 downloads at a time). */
export async function fetchAnthropicSkills(): Promise<CatalogItem[]> {
  const text = await fetchRepoText(ANTHROPIC_SKILLS_OWNER, ANTHROPIC_SKILLS_REPO, '.claude-plugin/marketplace.json', { maxBytes: 2 * 1024 * 1024 })
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('anthropics/skills has an unreadable marketplace.json')
  }
  const entries = skillPathsFromMarketplace(json)
  if (!entries.length) throw new Error('anthropics/skills lists no skills')
  return mapLimit(entries, 6, async (entry) => {
    try {
      const md = await downloadRepoFile(ANTHROPIC_SKILLS_OWNER, ANTHROPIC_SKILLS_REPO, `${entry.path}/SKILL.md`, { maxBytes: 1024 * 1024 })
      return anthropicSkillItem(entry, parseFrontmatter(md.toString('utf8')).data)
    } catch {
      return anthropicSkillItem(entry, {})
    }
  })
}
