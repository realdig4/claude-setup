/** Shared builder for sources that publish server.json documents (official, Anthropic, GitHub, PulseMCP). */
import type { CatalogSource, InstallOption } from '@shared/types'
import { nameKey, repoBaseKey } from '../keys'
import { displayNameFromRegistryName, isVendorNamespace, makeServer, publisherFromName } from '../normalize'
import { mapServerJson, serverJsonBasics, type ServerJson } from '../serverjson'
import type { Metrics, SourceEntry } from '../types'
import { asRecord, asString, isImageUrl, plainDescription, toIsoDate, uniq } from '../util'

/** `_meta["io.modelcontextprotocol.registry/official"]` */
export interface OfficialMeta {
  status?: string
  statusMessage?: string
  publishedAt?: string
  updatedAt?: string
  isLatest?: boolean
}

/** Read the official registry metadata block of a list item. */
export function officialMeta(item: Record<string, unknown>): OfficialMeta {
  const meta = asRecord(asRecord(item._meta)?.['io.modelcontextprotocol.registry/official']) ?? {}
  return {
    status: asString(meta.status),
    statusMessage: asString(meta.statusMessage),
    publishedAt: asString(meta.publishedAt),
    updatedAt: asString(meta.updatedAt),
    isLatest: meta.isLatest === undefined ? undefined : meta.isLatest === true
  }
}

export interface ServerJsonEntryOptions {
  /** Use the registry name as guard name (official namespace). */
  guard?: boolean
  id?: string
  name?: string
  nameExplicit?: boolean
  description?: string
  longDescription?: string
  publisher?: string
  repository?: string
  homepage?: string
  iconUrl?: string
  tags?: Array<string | undefined>
  sourceCategories?: string[]
  official?: boolean
  verified?: boolean
  stars?: number
  updatedAt?: string
  version?: string
  metrics?: Metrics
  deprecated?: string | true
  /** Replace the install options derived from packages/remotes. */
  install?: InstallOption[]
  extraKeys?: string[]
  extraSoftKeys?: string[]
  ref?: string
}

/** Build a SourceEntry from a server.json document plus source-specific overrides. */
export function serverJsonEntry(source: CatalogSource, server: ServerJson, o: ServerJsonEntryOptions = {}): SourceEntry | undefined {
  const basics = serverJsonBasics(server)
  if (!basics.name) return undefined
  const mapped = mapServerJson(server)
  const install = o.install ?? mapped.options
  const id = o.id ?? basics.name
  const explicitName = o.name ?? basics.title
  const name = explicitName ?? displayNameFromRegistryName(basics.name)
  const repository = o.repository ?? basics.repositoryUrl
  const keys = uniq([nameKey(basics.name), ...mapped.keys, ...(o.extraKeys ?? [])])
  const softKeys = uniq([...(mapped.repo ? [repoBaseKey(mapped.repo)] : []), ...mapped.softKeys, ...(o.extraSoftKeys ?? [])])
  const entry: SourceEntry = {
    source,
    sourceId: basics.name,
    keys,
    softKeys,
    nameExplicit: (o.nameExplicit ?? !!explicitName) || undefined,
    server: makeServer(source, {
      id,
      name,
      description: o.description ?? plainDescription(basics.description, 400),
      longDescription: o.longDescription,
      publisher: o.publisher ?? publisherFromName(basics.name),
      repository,
      homepage: o.homepage ?? basics.websiteUrl,
      iconUrl: o.iconUrl ?? (isImageUrl(basics.iconUrl) ? basics.iconUrl : undefined),
      tags: o.tags,
      sourceCategories: o.sourceCategories,
      official: o.official ?? isVendorNamespace(basics.name),
      verified: o.verified,
      stars: o.stars,
      updatedAt: o.updatedAt ? toIsoDate(o.updatedAt) : undefined,
      version: o.version ?? (basics.version && !/seed/i.test(basics.version) ? basics.version : undefined),
      install
    })
  }
  if (o.guard) entry.guardName = basics.name
  if (o.metrics) entry.metrics = o.metrics
  if (o.deprecated) entry.deprecated = o.deprecated
  if (o.ref) entry.ref = o.ref
  return entry
}
