/** Internal types of the extensions module (never sent over IPC as-is). */
import type { ExtensionItem } from '@shared/types'
import type { CoreContext } from '../context'
import type { ExtensionsCache } from './cache'
import type { InstallRegistry } from './registry'

/** A catalog entry plus internal fields used for dedupe and ranking. */
export interface CatalogItem extends ExtensionItem {
  /** Plugins: where the plugin's files live, "github.com/<owner>/<repo>#<path>" (dedupe across marketplaces). */
  sourceKey?: string
  /** Skills: "<owner>/<repo>:<slug>" (dedupe across sources). */
  dedupeKey?: string
  /** Ids of equivalent entries merged into this one (e.g. the same plugin listed by several marketplaces). */
  aliases?: string[]
  /** Published or reviewed by Anthropic (small ranking boost). */
  trusted?: boolean
  version?: string
  tags?: string[]
}

/** Shared services handed to every part of the extensions module. */
export interface ExtEnv {
  ctx: CoreContext
  cache: ExtensionsCache
  registry: InstallRegistry
  /** Emit a 'progress' event for long operations. */
  progress(message: string, pct?: number): void
}

const INTERNAL_KEYS = new Set(['sourceKey', 'dedupeKey', 'aliases', 'trusted', 'version', 'tags'])

/** Copy without internal fields and without undefined values (clean JSON over IPC). */
export function toPublicItem(item: CatalogItem): ExtensionItem {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(item)) if (v !== undefined && !INTERNAL_KEYS.has(k)) out[k] = v
  return out as unknown as ExtensionItem
}
