/** DoctorApi: health checks + one-click fixes. CONTRACT (owned by MODELS+DOCTOR). */
import type { DoctorApi, ModelsApi, ProxyApi, RuntimesApi, ServersApi, TargetsApi } from '@shared/api'
import type { CoreContext } from '../context'

export interface DoctorDeps {
  targets: TargetsApi
  servers: ServersApi
  models: ModelsApi
  runtimes: RuntimesApi
  proxy: ProxyApi
}

export function createDoctorApi(_ctx: CoreContext, _deps: DoctorDeps): DoctorApi {
  throw new Error('TODO(doctor): createDoctorApi')
}
