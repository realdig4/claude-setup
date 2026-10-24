/** SelfApi: register Claude Setup's own MCP server + CLI shim. CONTRACT (owned by ENTRYPOINTS). */
import type { SelfApi, ServersApi, TargetsApi } from '@shared/api'
import type { CoreContext } from '../context'

export interface SelfDeps {
  servers: ServersApi
  targets: TargetsApi
}

export function createSelfApi(_ctx: CoreContext, _deps: SelfDeps): SelfApi {
  throw new Error('TODO(entrypoints): createSelfApi')
}
