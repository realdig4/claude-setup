/**
 * Page registry: every screen of the app, its sidebar placement and route types.
 * The router (lib/store.ts) and the sidebar/command palette read from here.
 */
import { Blocks, BrainCircuit, Compass, History, House, Puzzle, Settings, Stethoscope, Waypoints, type LucideIcon } from 'lucide-react'

export type PageId = 'home' | 'discover' | 'installed' | 'models' | 'extensions' | 'doctor' | 'settings' | 'proxy' | 'backups'

export type NavSection = 'setup' | 'customize' | 'maintain'

/** Route params are small, serializable values (ids, flags, search text). */
export type RouteParams = Record<string, string | number | boolean | undefined>

export interface Route {
  page: PageId
  params: RouteParams
}

/** Props every page component receives from the router. */
export interface PageProps {
  params: RouteParams
}

export interface PageDef {
  id: PageId
  /** Sidebar / palette label (plain words, Simple-mode friendly). */
  label: string
  icon: LucideIcon
  section: NavSection
  /** Hidden from navigation in Simple mode. */
  advancedOnly: boolean
  /** One-line explanation shown in the command palette and as the default page subtitle. */
  description: string
  /** Extra search words for the command palette. */
  keywords: string[]
  /** Content width: 'default' (≈1120px) or 'wide' (≈1320px, for dense grids). */
  width: 'default' | 'wide'
}

export const NAV_SECTIONS: ReadonlyArray<{ id: NavSection; label: string }> = [
  { id: 'setup', label: 'Set up' },
  { id: 'customize', label: 'Customize' },
  { id: 'maintain', label: 'Maintain' }
]

export const PAGES: readonly PageDef[] = [
  {
    id: 'home',
    label: 'Home',
    icon: House,
    section: 'setup',
    advancedOnly: false,
    description: 'An overview of your Claude apps and what to do next.',
    keywords: ['overview', 'dashboard', 'start', 'welcome'],
    width: 'default'
  },
  {
    id: 'discover',
    label: 'Discover',
    icon: Compass,
    section: 'setup',
    advancedOnly: false,
    description: 'Find tools (MCP servers) that give Claude new abilities.',
    keywords: ['mcp', 'servers', 'catalog', 'browse', 'install', 'search', 'registry'],
    width: 'wide'
  },
  {
    id: 'installed',
    label: 'My Tools',
    icon: Blocks,
    section: 'setup',
    advancedOnly: false,
    description: 'Tools you have added to Claude — turn them on or off, test or remove them.',
    keywords: ['installed', 'servers', 'mcp', 'manage', 'remove', 'enable', 'disable'],
    width: 'default'
  },
  {
    id: 'models',
    label: 'Models',
    icon: BrainCircuit,
    section: 'customize',
    advancedOnly: false,
    description: 'Use other AI models like Kimi, DeepSeek or GLM in Claude Code.',
    keywords: ['provider', 'kimi', 'deepseek', 'glm', 'openrouter', 'ollama', 'api key', 'llm'],
    width: 'default'
  },
  {
    id: 'extensions',
    label: 'Extensions',
    icon: Puzzle,
    section: 'customize',
    advancedOnly: false,
    description: 'Plugins, skills, agents and commands for Claude Code.',
    keywords: ['plugins', 'skills', 'agents', 'commands', 'hooks', 'marketplace', 'claude.md', 'status line'],
    width: 'default'
  },
  {
    id: 'proxy',
    label: 'Proxy',
    icon: Waypoints,
    section: 'customize',
    advancedOnly: true,
    description: 'A local translator that lets Claude Code talk to OpenAI-style providers.',
    keywords: ['openai', 'translation', 'gateway', 'groq', 'gemini', 'port', 'logs'],
    width: 'default'
  },
  {
    id: 'doctor',
    label: 'Health Check',
    icon: Stethoscope,
    section: 'maintain',
    advancedOnly: false,
    description: 'Find and fix common problems with one click.',
    keywords: ['doctor', 'diagnose', 'fix', 'problems', 'troubleshoot', 'runtimes', 'node', 'path'],
    width: 'default'
  },
  {
    id: 'backups',
    label: 'Backups',
    icon: History,
    section: 'maintain',
    advancedOnly: true,
    description: 'Every config file is backed up before it changes. Restore any version.',
    keywords: ['restore', 'undo', 'history', 'snapshot'],
    width: 'default'
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    section: 'maintain',
    advancedOnly: false,
    description: 'Appearance, catalog sources, defaults and Claude Setup itself.',
    keywords: ['preferences', 'theme', 'dark', 'light', 'mode', 'sources', 'about'],
    width: 'default'
  }
]

const PAGE_MAP = new Map<PageId, PageDef>(PAGES.map((p) => [p.id, p]))

/** Look up a page definition (throws for unknown ids — a programming error). */
export function getPage(id: PageId): PageDef {
  const page = PAGE_MAP.get(id)
  if (!page) throw new Error(`Unknown page: ${id}`)
  return page
}

/** Type guard for values coming from URLs, storage or the command palette. */
export function isPageId(value: unknown): value is PageId {
  return typeof value === 'string' && PAGE_MAP.has(value as PageId)
}

/** Pages shown in navigation for the given mode, in sidebar order. */
export function visiblePages(mode: 'simple' | 'advanced'): PageDef[] {
  return PAGES.filter((p) => mode === 'advanced' || !p.advancedOnly)
}

/** Pages grouped by sidebar section (empty sections omitted). */
export function navGroups(mode: 'simple' | 'advanced'): Array<{ id: NavSection; label: string; pages: PageDef[] }> {
  const pages = visiblePages(mode)
  return NAV_SECTIONS.map((s) => ({ ...s, pages: pages.filter((p) => p.section === s.id) })).filter((g) => g.pages.length > 0)
}

/** Two routes are equal when page and every param match. */
export function sameRoute(a: Route, b: Route): boolean {
  if (a.page !== b.page) return false
  const keys = new Set([...Object.keys(a.params), ...Object.keys(b.params)])
  for (const key of keys) if (a.params[key] !== b.params[key]) return false
  return true
}

/** Drop undefined values so routes compare and serialize cleanly. */
export function cleanParams(params: RouteParams | undefined): RouteParams {
  const out: RouteParams = {}
  if (!params) return out
  for (const [key, value] of Object.entries(params)) if (value !== undefined) out[key] = value
  return out
}
