/**
 * Bundled catalog seed (resources/catalog-seed.json, produced by scripts/build-seed.mjs).
 * The file holds trimmed raw payloads of the curated registries (Claude directory, GitHub MCP registry,
 * Docker catalog); they are normalised here with exactly the same parsers as a live refresh, so the
 * catalog works offline on first run in every surface (GUI, CLI, MCP).
 */
import type { CatalogSource } from '@shared/types'
import { parseAnthropicItem } from './sources/anthropic'
import { parseDockerCatalog } from './sources/docker'
import { parseGithubItem } from './sources/github'
import type { SourceEntry } from './types'
import { asArray, asRecord } from './util'

export const SEED_FORMAT = 'claude-setup-catalog-seed'

export interface SeedPayload {
  format: typeof SEED_FORMAT
  version: 1
  /** When the payloads were crawled (ISO). */
  generatedAt: string
  sources: {
    anthropic?: unknown[]
    github?: unknown[]
    /** Parsed catalog.yaml document ({ registry: {…} }). */
    docker?: unknown
  }
}

/** Runtime check of a seed document. */
export function isSeedPayload(value: unknown): value is SeedPayload {
  const v = asRecord(value)
  return !!v && v.format === SEED_FORMAT && v.version === 1 && typeof v.generatedAt === 'string' && !!asRecord(v.sources)
}

/** Load the bundled seed (null when missing or unreadable). */
export async function loadBundledSeed(): Promise<SeedPayload | null> {
  try {
    const mod = (await import('../../../resources/catalog-seed.json')) as unknown as { default?: unknown }
    const data = mod.default ?? mod
    return isSeedPayload(data) ? data : null
  } catch {
    return null
  }
}

/** Normalise the bundled payloads into source entries (per source). */
export function bundledEntries(payload: SeedPayload): Partial<Record<CatalogSource, SourceEntry[]>> {
  const out: Partial<Record<CatalogSource, SourceEntry[]>> = {}
  const anthropic = asArray(payload.sources.anthropic)
    .map(parseAnthropicItem)
    .filter((e): e is SourceEntry => !!e)
  if (anthropic.length) out.anthropic = anthropic
  const github = asArray(payload.sources.github)
    .map(parseGithubItem)
    .filter((e): e is SourceEntry => !!e)
  if (github.length) out.github = github
  const docker = parseDockerCatalog(payload.sources.docker)
  if (docker.length) out.docker = docker
  return out
}
