/** ServersApi: install / remove / enable / test MCP servers across targets. CONTRACT (owned by TARGETS). */
import type { CatalogApi, ServersApi } from '@shared/api'
import type { CoreContext } from '../context'

export interface ServersDeps {
  catalog: CatalogApi
}

export function createServersApi(_ctx: CoreContext, _deps: ServersDeps): ServersApi {
  throw new Error('TODO(targets): createServersApi')
}
