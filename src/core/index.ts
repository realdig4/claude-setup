/**
 * Core facade: builds every API namespace on top of a shared CoreContext.
 * Used identically by the Electron main process, the CLI and the MCP server.
 */
import type { CoreApi } from '@shared/api'
import { createAppApi } from './app'
import { createContext, type CoreContext, type CoreOptions } from './context'
import { createDoctorApi } from './doctor'
import { createExtensionsApi } from './extensions'
import { createBackupsApi } from './fs/backups'
import { createModelsApi } from './models'
import { fixPath } from './platform/exec'
import { createRuntimesApi } from './platform/runtimes'
import { createProxyApi } from './proxy'
import { createCatalogApi } from './registry'
import { createSelfApi } from './self'
import { createServersApi } from './servers'
import { createTargetsApi } from './targets'

export type { CoreOptions, CoreContext }

export interface Core extends CoreApi {
  ctx: CoreContext
  /** Stop background work (proxy server, timers). */
  dispose(): Promise<void>
}

export async function createCore(options: CoreOptions): Promise<Core> {
  await fixPath().catch(() => {})
  const ctx = await createContext(options)

  const app = createAppApi(ctx)
  const catalog = createCatalogApi(ctx)
  const targets = createTargetsApi(ctx)
  const servers = createServersApi(ctx, { catalog })
  const proxy = createProxyApi(ctx)
  const models = createModelsApi(ctx, { proxy })
  const runtimes = createRuntimesApi(ctx)
  const backups = createBackupsApi(ctx)
  const extensions = createExtensionsApi(ctx)
  const doctor = createDoctorApi(ctx, { targets, servers, models, runtimes, proxy })
  const self = createSelfApi(ctx, { servers, targets })

  return {
    ctx,
    app,
    catalog,
    targets,
    servers,
    models,
    proxy,
    extensions,
    doctor,
    backups,
    runtimes,
    self,
    async dispose() {
      await proxy.stop().catch(() => {})
    }
  }
}
