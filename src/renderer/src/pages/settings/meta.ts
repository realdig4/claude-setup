/**
 * Settings page data: catalog sources, optional keys and choice lists. Pure (no React or DOM).
 */
import type { AppSettings, CatalogSource, TargetId, TargetInfo, TargetRef } from '@shared/types'

export interface SourceMeta {
  label: string
  description: string
  /** Settings key holding the API key this source needs (the source is unavailable without it). */
  needsKey?: 'glamaKeyRef' | 'pulsemcpKeyRef'
}

export const SOURCE_ORDER: readonly CatalogSource[] = [
  'official',
  'anthropic',
  'github',
  'smithery',
  'docker',
  'cline',
  'awesome',
  'glama',
  'pulsemcp',
  'seed'
]

export const SOURCE_META: Record<CatalogSource, SourceMeta> = {
  official: { label: 'Official MCP Registry', description: 'The open registry run by the MCP project — the biggest list.' },
  anthropic: { label: 'Claude connectors directory', description: 'Remote tools reviewed for Claude.' },
  github: { label: 'GitHub MCP Registry', description: 'A curated list from GitHub, with star counts.' },
  smithery: { label: 'Smithery', description: 'Thousands of tools, many hosted online so nothing runs on your computer.' },
  docker: { label: 'Docker MCP Catalog', description: 'Tools packaged as containers (they need Docker).' },
  cline: { label: 'Cline Marketplace', description: 'Popular picks with download counts.' },
  awesome: { label: 'Awesome MCP Servers', description: 'A big community list on GitHub, for discovery.' },
  glama: { label: 'Glama', description: 'A large directory of tools. Needs a free Glama API key.', needsKey: 'glamaKeyRef' },
  pulsemcp: {
    label: 'PulseMCP',
    description: 'A directory with usage estimates. Needs a PulseMCP partner key.',
    needsKey: 'pulsemcpKeyRef'
  },
  seed: { label: 'Built-in picks', description: 'A hand-picked list that ships with Claude Setup and works offline.' }
}

export type KeySettingsKey = 'smitheryKeyRef' | 'githubTokenRef' | 'glamaKeyRef' | 'pulsemcpKeyRef'

export interface KeyMeta {
  id: string
  settingsKey: KeySettingsKey
  /** Secret store reference used when settings don't name one yet. */
  defaultRef: string
  title: string
  description: string
  url: string
  urlLabel: string
  placeholder: string
  /** Catalog source this key unlocks (turned on when the key is saved). */
  source?: CatalogSource
}

export const KEY_META: readonly KeyMeta[] = [
  {
    id: 'github',
    settingsKey: 'githubTokenRef',
    defaultRef: 'app:github-token',
    title: 'GitHub token',
    description:
      'Raises GitHub’s limit from 60 to 5,000 requests an hour — useful for marketplaces, skills and catalog refreshes. ' +
      'It needs no permissions.',
    url: 'https://github.com/settings/personal-access-tokens/new',
    urlLabel: 'Create a token',
    placeholder: 'github_pat_… or ghp_…'
  },
  {
    id: 'smithery',
    settingsKey: 'smitheryKeyRef',
    defaultRef: 'app:smithery-key',
    title: 'Smithery API key',
    description: 'Lets Claude Setup connect hosted Smithery tools for you. Sign in at smithery.ai and copy a key from your account.',
    url: 'https://smithery.ai',
    urlLabel: 'Open smithery.ai',
    placeholder: 'Smithery API key'
  },
  {
    id: 'glama',
    settingsKey: 'glamaKeyRef',
    defaultRef: 'app:glama-key',
    title: 'Glama API key',
    description: 'Adds the Glama directory to Discover.',
    url: 'https://glama.ai/settings/api-keys',
    urlLabel: 'Get a key',
    placeholder: 'Glama API key',
    source: 'glama'
  },
  {
    id: 'pulsemcp',
    settingsKey: 'pulsemcpKeyRef',
    defaultRef: 'app:pulsemcp-key',
    title: 'PulseMCP API key',
    description: 'Adds the PulseMCP directory. Keys are for PulseMCP partners — you also need your tenant ID.',
    url: 'https://www.pulsemcp.com/api',
    urlLabel: 'About PulseMCP keys',
    placeholder: 'PulseMCP API key',
    source: 'pulsemcp'
  }
]

export const TTL_CHOICES: ReadonlyArray<{ hours: number; label: string }> = [
  { hours: 6, label: 'Every 6 hours' },
  { hours: 12, label: 'Every 12 hours' },
  { hours: 24, label: 'Once a day' },
  { hours: 72, label: 'Every 3 days' },
  { hours: 168, label: 'Once a week' }
]

export const KEEP_CHOICES: readonly number[] = [10, 20, 30, 50, 100, 200]

/** Choice lists that always include the current value (even if it's not one of the presets). */
export function withCurrent(choices: readonly number[], current: number | undefined): number[] {
  const list = [...choices]
  if (current !== undefined && Number.isFinite(current) && !list.includes(current)) list.push(current)
  return list.sort((a, b) => a - b)
}

/** "Every 36 hours" for values that aren't in TTL_CHOICES. */
export function ttlLabel(hours: number): string {
  return TTL_CHOICES.find((c) => c.hours === hours)?.label ?? `Every ${hours} ${hours === 1 ? 'hour' : 'hours'}`
}

/** The ref for a key setting: the one in settings, else the default. */
export function keyRef(settings: Pick<AppSettings, KeySettingsKey> | null | undefined, meta: KeyMeta): string {
  return settings?.[meta.settingsKey] || meta.defaultRef
}

/** True when an app is selected as a default install target. */
export function isDefaultTarget(settings: Pick<AppSettings, 'defaultTargets'> | null | undefined, id: TargetId): boolean {
  return !!settings?.defaultTargets.some((t) => t.target === id)
}

/** The default-target list with an app switched on (user scope where the app has scopes) or off. */
export function toggleDefaultTarget(current: readonly TargetRef[], target: TargetInfo, on: boolean): TargetRef[] {
  const others = current.filter((t) => t.target !== target.id)
  if (!on) return others
  const userScope = target.scopes.includes('user') && target.id !== 'claude-desktop'
  const ref: TargetRef = userScope ? { target: target.id, scope: 'user' } : { target: target.id }
  return [...others, ref]
}
