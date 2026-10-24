/** ModelsApi: third-party model providers & profiles for Claude Code / VS Code. CONTRACT (owned by MODELS). */
import type { ModelsApi, ProxyApi } from '@shared/api'
import type { CoreContext } from '../context'

export interface ModelsDeps {
  proxy: ProxyApi
}

export function createModelsApi(_ctx: CoreContext, _deps: ModelsDeps): ModelsApi {
  throw new Error('TODO(models): createModelsApi')
}
