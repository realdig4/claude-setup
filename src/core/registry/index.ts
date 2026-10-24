/**
 * CatalogApi: aggregate every public MCP registry (official, Claude directory, GitHub, Smithery, Docker,
 * Cline, awesome list, optional Glama / PulseMCP) into one de-duplicated, searchable catalog with a
 * bundled offline seed. CONTRACT (owned by REGISTRY).
 */
import type { CatalogApi } from '@shared/api'
import type { CoreContext } from '../context'
import { createCatalogService } from './service'

/** Build the CatalogApi for a core context. The database is opened lazily on first use. */
export function createCatalogApi(ctx: CoreContext): CatalogApi {
  return createCatalogService(ctx).api
}

export { createCatalogService, CatalogService, type CatalogServiceOptions } from './service'
export { buildServerConfig, applyHeaderTemplate, expandArgs, type LaunchResult } from './launch'
export { CATEGORIES, categoryLabel, resolveCategory } from './categories'
export { FEATURED_IDS } from './seed'
