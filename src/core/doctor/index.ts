/**
 * DoctorApi: health checks + one-click fixes. CONTRACT (owned by MODELS+DOCTOR).
 *
 * run() executes every check group in parallel (each with its own timeout; a failing check becomes a 'warn' row
 * instead of breaking the report). fix(id) runs one of the fixes referenced by the checks (see fixes.ts).
 */
import type { DoctorApi } from '@shared/api'
import type { CheckStatus, DoctorCheck, DoctorReport } from '@shared/types'
import type { CoreContext } from '../context'
import { claudeCodeChecks } from './checks/claudeCode'
import { desktopChecks } from './checks/desktop'
import { mcpChecks } from './checks/mcp'
import { modelChecks } from './checks/models'
import { runtimeChecks } from './checks/runtimes'
import { systemChecks } from './checks/system'
import { vscodeChecks } from './checks/vscode'
import { createRunContext, runGroup, type CheckGroup, type DoctorDeps } from './context'
import { runFix } from './fixes'

export type { DoctorDeps } from './context'
export { FIX_IDS } from './fixes'

/** Check groups in display order. */
export const CHECK_GROUPS: readonly CheckGroup[] = [
  runtimeChecks,
  desktopChecks,
  claudeCodeChecks,
  vscodeChecks,
  modelChecks,
  mcpChecks,
  systemChecks
]

/** Count checks per status. */
export function summarize(checks: DoctorCheck[]): Record<CheckStatus, number> {
  const summary: Record<CheckStatus, number> = { ok: 0, warn: 0, error: 0, info: 0, skip: 0 }
  for (const c of checks) summary[c.status] = (summary[c.status] ?? 0) + 1
  return summary
}

/** Build the DoctorApi. */
export function createDoctorApi(ctx: CoreContext, deps: DoctorDeps): DoctorApi {
  return {
    async run(): Promise<DoctorReport> {
      const started = Date.now()
      const rc = createRunContext(ctx, deps)
      const groups = await Promise.all(CHECK_GROUPS.map((group) => runGroup(rc, group)))
      const checks = groups.flat().map((c) => JSON.parse(JSON.stringify(c)) as DoctorCheck)
      const summary = summarize(checks)
      const counts = `${summary.error} error(s), ${summary.warn} warning(s), ${summary.ok} ok`
      ctx.log.info('doctor', `Doctor finished in ${Date.now() - started} ms: ${counts}`)
      return { ranAt: new Date().toISOString(), checks, summary }
    },

    async fix(fixId: string) {
      const result = await runFix(ctx, deps, fixId)
      ctx.log[result.ok ? 'info' : 'warn']('doctor', `Fix ${fixId}: ${result.message}`)
      return result
    }
  }
}
