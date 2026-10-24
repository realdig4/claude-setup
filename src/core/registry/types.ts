/** Internal types of the registry module (not part of the shared API contract). */
import type { CatalogServer, CatalogSource, EnvVarSpec } from '@shared/types'

/** Raw popularity signals reported by a source. */
export interface Metrics {
  stars?: number
  /** Smithery useCount. */
  useCount?: number
  /** Docker Hub pulls. */
  pulls?: number
  /** Cline / npm downloads. */
  downloads?: number
  /** PulseMCP visitor estimate (last 4 weeks). */
  visitors?: number
}

/**
 * One server as described by a single source. Entries from all sources are grouped by
 * matching keys (dedupe.ts) and merged into one CatalogServer per group.
 */
export interface SourceEntry {
  source: CatalogSource
  /** Unique within its source (official name, Smithery qualifiedName, Docker key…). */
  sourceId: string
  /**
   * Name in the official MCP registry namespace. Two entries with different guard names are
   * never merged (monorepos publish many servers sharing packages / repos / URLs).
   */
  guardName?: string
  /** Hard matching keys (see keys.ts): name/package/remote/repo+subfolder keys. */
  keys: string[]
  /**
   * Soft keys: only used when they point at exactly one candidate group
   * (repo without subfolder, /mcp vs /sse host match, Smithery qualifiedName as owner/repo…).
   */
  softKeys?: string[]
  /** Normalised view of the server according to this source alone. */
  server: CatalogServer
  /** The source published a human title for the server (vs. a name derived from a package/slug). */
  nameExplicit?: boolean
  metrics?: Metrics
  /** Official registry status "deprecated" (with optional message). */
  deprecated?: string | true
  /** Source-specific reference used for lazy enrichment (e.g. Smithery qualifiedName). */
  ref?: string
}

/** A merged server plus the derived columns the store indexes. */
export interface MergedServer {
  server: CatalogServer
  /** At least one remote install option. */
  remote: boolean
  /** Every install option needs a secret (API key / token). */
  needsKey: boolean
  /** All source ids / provisional ids that resolve to this server (for get() after re-merges). */
  aliases: string[]
  /** Source → source-specific reference (e.g. { smithery: 'brave' }). */
  refs: Partial<Record<CatalogSource, string>>
}

/** Header spec with an optional value template ("Bearer {{value}}"); see launch.ts. */
export type HeaderSpec = EnvVarSpec & { template?: string }
