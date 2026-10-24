/** All network sources, quick ones first (the bundled 'seed' source is handled by the service). */
import { anthropicSource } from './anthropic'
import { awesomeSource } from './awesome'
import { clineSource } from './cline'
import { dockerSource } from './docker'
import { githubSource } from './github'
import { glamaSource } from './glama'
import { officialSource } from './official'
import { pulsemcpSource } from './pulsemcp'
import { smitherySource } from './smithery'
import type { SourceAdapter } from './source'

export const NETWORK_SOURCES: readonly SourceAdapter[] = [
  anthropicSource,
  githubSource,
  dockerSource,
  clineSource,
  awesomeSource,
  officialSource,
  smitherySource,
  glamaSource,
  pulsemcpSource
]

export type { SourceAdapter, SourceRunContext, SourceState } from './source'
