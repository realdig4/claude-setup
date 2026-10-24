/** SelfApi: register Claude Setup's own MCP server + CLI shim. CONTRACT (owned by ENTRYPOINTS). */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SelfApi, ServersApi, TargetsApi } from '@shared/api'
import type { InstallResult, InstalledServer, OpResult, TargetChangeResult, TargetId, TargetRef } from '@shared/types'
import type { CoreContext } from '../context'
import { writeTextAtomic } from '../fs/json'
import { currentOS, homeDir } from '../platform/paths'
import { ALL_TARGETS, SELF_SERVER_NAME, cliLaunchFromConfig, unstableLocationReason } from './launch'
import { SHIM_MARKER, cliShimPlan, isDirOnPath, pathAdvice, pathFromEnv } from './shim'

export { ALL_TARGETS, SELF_SERVER_NAME } from './launch'

/** Core APIs the self module builds on. */
export interface SelfDeps {
  servers: ServersApi
  targets: TargetsApi
}

const TARGET_LABELS: Record<TargetId, string> = {
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  vscode: 'VS Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf'
}

/** Folder that receives the `claude-setup` command shim. */
export function cliBinDir(): string {
  return join(homeDir(), '.local', 'bin')
}

/**
 * Absolute path of the `claude-setup` command written by installCli(). Use it (quoted) in
 * apiKeyHelper so the helper works even when ~/.local/bin is not on PATH.
 */
export function cliCommandPath(platform: NodeJS.Platform = process.platform): string {
  return join(cliBinDir(), platform === 'win32' ? 'claude-setup.cmd' : 'claude-setup')
}

/** Friendly reason why this copy has no self launch config. */
export function selfUnavailableReason(ctx: CoreContext): string {
  const script = process.argv[1]
  const fromLocation = unstableLocationReason({
    platform: process.platform,
    execPath: process.execPath,
    entryDir: script ? dirname(script) : undefined,
    env: process.env
  })
  if (fromLocation) return fromLocation
  if (ctx.options.surface === 'mcp') return 'Claude Setup is already running as an MCP server here. Register it from the Claude Setup app.'
  return 'Claude Setup could not work out how to start itself from this copy. Open the installed Claude Setup app and try again there.'
}

/** Claude Code and VS Code default to user scope so Claude Setup is available in every project. */
function withDefaultScope(ref: TargetRef): TargetRef {
  if ((ref.target === 'claude-code' || ref.target === 'vscode') && !ref.scope) return { ...ref, scope: 'user' }
  return ref
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function listSelfEntries(servers: ServersApi, targets: TargetId[]): Promise<Map<TargetId, InstalledServer[] | null>> {
  const lists = await Promise.all(
    targets.map(async (target) => {
      try {
        const all = await servers.list({ target })
        return all.filter((s) => s.name === SELF_SERVER_NAME && s.target.target === target)
      } catch {
        return null
      }
    })
  )
  return new Map(targets.map((t, i) => [t, lists[i]]))
}

/** SelfApi: register Claude Setup's own MCP server and install the `claude-setup` command. */
export function createSelfApi(ctx: CoreContext, deps: SelfDeps): SelfApi {
  return {
    async mcpStatus() {
      const [infos, entries] = await Promise.all([deps.targets.list().catch(() => []), listSelfEntries(deps.servers, ALL_TARGETS)])
      return ALL_TARGETS.map((target) => {
        const found = entries.get(target) ?? []
        const info = infos.find((i) => i.id === target)
        return { target, registered: found.length > 0, configPath: found[0]?.configPath ?? info?.configPath }
      })
    },

    async registerMcp(targets) {
      const config = ctx.options.selfMcpConfig
      if (!config) {
        const reason = selfUnavailableReason(ctx)
        return {
          ok: false,
          name: SELF_SERVER_NAME,
          results: targets.map((target) => ({ target, ok: false, message: reason })),
          warnings: [reason]
        } satisfies InstallResult
      }
      if (!targets.length) {
        return { ok: false, name: SELF_SERVER_NAME, results: [], warnings: ['Choose at least one app to add Claude Setup to.'] }
      }
      const refs = targets.map(withDefaultScope)
      ctx.log.info('self', `Registering Claude Setup's MCP server in ${refs.map((r) => r.target).join(', ')}`)
      try {
        return await deps.servers.install({ config, name: SELF_SERVER_NAME, targets: refs, overwrite: true })
      } catch (err) {
        const message = `Could not add Claude Setup: ${errorMessage(err)}`
        ctx.log.error('self', message)
        return { ok: false, name: SELF_SERVER_NAME, results: refs.map((target) => ({ target, ok: false, message })), warnings: [] }
      }
    },

    async unregisterMcp(targets) {
      const wanted = targets.length ? [...new Set(targets.map((t) => t.target))] : ALL_TARGETS
      const entries = await listSelfEntries(deps.servers, wanted)
      const toRemove: TargetRef[] = []
      const results: TargetChangeResult[] = []
      for (const target of wanted) {
        const requested = targets.filter((t) => t.target === target)
        const found = (entries.get(target) ?? []).filter((s) =>
          requested.length === 0 || requested.some((r) => !r.scope || r.scope === s.target.scope)
        )
        if (found.length) toRemove.push(...found.map((s) => s.target))
        else if (targets.length) {
          results.push({ target: requested[0] ?? { target }, ok: true, message: `Claude Setup was not registered in ${TARGET_LABELS[target]}.` })
        }
      }
      if (!toRemove.length) return results
      try {
        return [...(await deps.servers.uninstall(SELF_SERVER_NAME, toRemove)), ...results]
      } catch (err) {
        const message = `Could not remove Claude Setup: ${errorMessage(err)}`
        ctx.log.error('self', message)
        return [...toRemove.map((target) => ({ target, ok: false, message })), ...results]
      }
    },

    async installCli(): Promise<OpResult> {
      const platform = process.platform
      const config = ctx.options.selfMcpConfig
      const launch = cliLaunchFromConfig(config, platform)
      if (!launch) {
        return { ok: false, message: `The claude-setup command can't be installed from this copy. ${selfUnavailableReason(ctx)}` }
      }
      const binDir = cliBinDir()
      const plan = cliShimPlan(launch, platform, binDir, process.env)
      try {
        const existing = await readFile(plan.path, 'utf8').catch(() => null)
        let backupId: string | undefined
        if (existing !== null && existing !== plan.content && !existing.includes(SHIM_MARKER)) {
          backupId = (await ctx.backups.snapshot('Replace the claude-setup command', [plan.path])).id
        }
        if (existing !== plan.content) await writeTextAtomic(plan.path, plan.content, { mode: plan.mode })
        ctx.log.info('self', `Installed the claude-setup command at ${plan.path}`)
        const onPath = isDirOnPath(binDir, pathFromEnv(process.env, platform), platform, process.env)
        if (onPath) {
          return {
            ok: true,
            message: 'The claude-setup command is ready. Open a new terminal window and run: claude-setup --help',
            details: `Command file: ${plan.path}`,
            backupId
          }
        }
        return {
          ok: true,
          message: `The claude-setup command was installed in ${binDir}, but that folder is not on your PATH yet.`,
          details: `${pathAdvice(binDir, currentOS(), process.env.SHELL)}\n\nCommand file: ${plan.path}`,
          backupId
        }
      } catch (err) {
        const message = `Could not install the claude-setup command: ${errorMessage(err)}`
        ctx.log.error('self', message)
        return { ok: false, message, details: `Tried to write ${plan.path}` }
      }
    }
  }
}
