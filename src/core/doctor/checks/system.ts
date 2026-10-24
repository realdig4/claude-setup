/** System: Git long paths on Windows (plugin marketplaces have deep folders) and where secrets are stored. */
import type { DoctorCheck } from '@shared/types'
import { run } from '../../platform/exec'
import { homeDir } from '../../platform/paths'
import { guard, type CheckGroup, type RunContext } from '../context'

const CATEGORY = 'system' as const

/** Effective `core.longpaths` value (system + global config), or null when Git can't be asked. */
export async function gitLongPaths(gitPath: string): Promise<string | null> {
  const r = await run(gitPath, ['config', '--get', 'core.longpaths'], { cwd: homeDir(), timeoutMs: 10_000 })
  if (r.error || r.timedOut) return null
  // Exit code 1 simply means "not set".
  return r.ok ? r.stdout.trim().toLowerCase() : ''
}

async function longPathsCheck(rc: RunContext): Promise<DoctorCheck | null> {
  if (rc.os !== 'win32') return null
  const git = await rc.runtime('git')
  if (!git?.found) return null
  const value = await gitLongPaths(git.path ?? 'git')
  if (value === null) return null
  const base = { id: 'system:longpaths', category: CATEGORY, title: 'Long file paths for Git' }
  if (value === 'true') return { ...base, status: 'ok', detail: 'Git can handle long file paths (core.longpaths is on).' }
  return {
    ...base,
    status: 'info',
    detail: 'Git\'s long-path support is off. Plugin marketplaces with deep folders can then fail to download with "Filename too long".',
    fix: { id: 'git-longpaths', label: 'Turn on long paths', auto: true }
  }
}

function secretsCheck(rc: RunContext): DoctorCheck {
  const backend = rc.ctx.secrets.backend()
  const base = { id: 'system:secrets', category: CATEGORY, title: 'API key storage' }
  if (backend.startsWith('Local file')) {
    return {
      ...base,
      status: 'info',
      detail: `Your system's secure storage isn't available, so API keys are kept in a local file only your account can read (${backend}).`
    }
  }
  if (/local file/i.test(backend)) {
    return { ...base, status: 'info', detail: `API keys are stored with ${backend} — the system keyring was unavailable for some of them.` }
  }
  return { ...base, status: 'ok', detail: `API keys are stored with ${backend}.` }
}

export const systemChecks: CheckGroup = {
  id: 'system',
  category: CATEGORY,
  title: 'System',
  timeoutMs: 20_000,
  async run(rc) {
    const results = await Promise.all([
      guard('system:longpaths', CATEGORY, 'Long file paths for Git', () => longPathsCheck(rc)),
      guard('system:secrets', CATEGORY, 'API key storage', async () => secretsCheck(rc))
    ])
    return results.flat()
  }
}
