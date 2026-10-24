import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  cli: { path: '/fake/bin/claude' as string | null }
}))
vi.mock('@core/platform/exec', () => ({ run: mocks.run, which: vi.fn(async () => '/usr/bin/tool') }))
vi.mock('@core/platform/runtimes', () => ({ findClaudeCli: vi.fn(async () => mocks.cli.path) }))

import type { RunOptions, RunResult } from '@core/platform/exec'
import { createExtensionsApi } from '@core/extensions'
import { createSandbox, type Sandbox } from '../helpers/sandbox'
import { makeCtx, withPlatform, type TestContext } from './helpers'

type Responder = (args: string[], opts: RunOptions | undefined) => RunResult | undefined

const ok = (json: unknown): RunResult => ({ ok: true, code: 0, stdout: `${typeof json === 'string' ? json : JSON.stringify(json)}\n`, stderr: '', timedOut: false })
const fail = (json: unknown, stderr = ''): RunResult => ({ ok: false, code: 1, stdout: `${JSON.stringify(json)}\n`, stderr, timedOut: false })

interface Call {
  command: string
  args: string[]
  opts?: RunOptions
}

describe('plugins through the claude CLI', () => {
  let sb: Sandbox
  let t: TestContext
  let calls: Call[]
  let savedGitCount: string | undefined

  const fakeCli = (responder: Responder) => {
    mocks.run.mockImplementation(async (command: string, args: string[], opts?: RunOptions) => {
      calls.push({ command, args, opts })
      const r = responder(args, opts)
      if (r) return r
      if (args.join(' ') === 'plugin marketplace list --json') return ok([])
      return fail({ outcome: 'failed', message: `unexpected: ${args.join(' ')}`, failureCode: 'error_unknown' })
    })
  }
  const pluginsDir = () => join(sb.home, '.claude', 'plugins')
  const writePluginsFile = async (name: string, data: unknown) => {
    await mkdir(pluginsDir(), { recursive: true })
    await writeFile(join(pluginsDir(), name), JSON.stringify(data))
  }

  beforeEach(async () => {
    sb = await createSandbox()
    t = await makeCtx(sb)
    calls = []
    mocks.cli.path = '/fake/bin/claude'
    mocks.run.mockReset()
    savedGitCount = process.env.GIT_CONFIG_COUNT
    delete process.env.GIT_CONFIG_COUNT
  })
  afterEach(async () => {
    if (savedGitCount !== undefined) process.env.GIT_CONFIG_COUNT = savedGitCount
    await sb.cleanup()
  })

  it('asks for Claude Code when the CLI is missing', async () => {
    mocks.cli.path = null
    const r = await createExtensionsApi(t.ctx).install('plugin:commit-commands@claude-plugins-official')
    expect(r).toMatchObject({ ok: false, message: 'Install Claude Code first' })
    expect(r.details).toMatch(/Install Claude Code/)
    expect(mocks.run).not.toHaveBeenCalled()
    expect(t.snapshots).toHaveLength(0)
  })

  it('adds the official marketplace, then installs, with the Windows long-path environment', async () => {
    fakeCli((args) => {
      const line = args.join(' ')
      if (line === 'plugin marketplace add anthropics/claude-plugins-official --json')
        return ok({ command: 'marketplace-add', outcome: 'ok', marketplace: 'claude-plugins-official', message: 'Successfully added marketplace' })
      if (line === 'plugin install commit-commands@claude-plugins-official --scope user --json')
        return ok({ command: 'install', outcome: 'ok', pluginId: 'commit-commands@claude-plugins-official', scope: 'user', message: 'Successfully installed plugin' })
      return undefined
    })
    const r = await withPlatform('win32', () => createExtensionsApi(t.ctx).install('plugin:commit-commands@claude-plugins-official'))
    expect(r.ok, r.details).toBe(true)
    expect(r.message).toMatch(/Installed the "commit-commands" plugin for all your projects/)
    expect(r.message).toMatch(/\/reload-plugins/)
    expect(calls.map((c) => c.args.join(' '))).toEqual([
      'plugin marketplace list --json',
      'plugin marketplace add anthropics/claude-plugins-official --json',
      'plugin install commit-commands@claude-plugins-official --scope user --json'
    ])
    for (const c of calls) {
      expect(c.command).toBe('/fake/bin/claude')
      expect(c.opts?.env).toMatchObject({
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.longpaths',
        GIT_CONFIG_VALUE_0: 'true',
        CLAUDE_CODE_PLUGIN_PREFER_HTTPS: '1'
      })
      expect(c.opts?.cwd).toBeUndefined()
    }
    expect(t.snapshots[0].paths).toEqual([
      join(sb.home, '.claude', 'settings.json'),
      join(pluginsDir(), 'installed_plugins.json'),
      join(pluginsDir(), 'known_marketplaces.json')
    ])
  })

  it('skips the marketplace step when it is already known or built in', async () => {
    await writePluginsFile('known_marketplaces.json', {
      'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' }, installLocation: 'x' }
    })
    fakeCli((args) => (args[1] === 'install' ? ok({ outcome: 'ok', message: 'Successfully installed plugin' }) : undefined))
    const api = createExtensionsApi(t.ctx)
    expect((await api.install('plugin:commit-commands@claude-plugins-official')).ok).toBe(true)
    expect((await api.install('frontend-design@anthropic-plugin-directory')).ok).toBe(true)
    expect(calls.map((c) => c.args.join(' '))).toEqual([
      'plugin install commit-commands@claude-plugins-official --scope user --json',
      'plugin install frontend-design@anthropic-plugin-directory --scope user --json'
    ])
  })

  it('needs unknown marketplaces to be added first', async () => {
    fakeCli(() => undefined)
    const r = await createExtensionsApi(t.ctx).install('plugin:tool@someone-elses-market')
    expect(r).toMatchObject({ ok: false, message: 'Add the "someone-elses-market" marketplace first.' })
    expect(calls.map((c) => c.args[1])).toEqual(['marketplace'])
  })

  it('installs for a project from the project folder', async () => {
    const project = join(sb.root, 'proj')
    await mkdir(project, { recursive: true })
    fakeCli((args) => (args[1] === 'install' ? ok({ outcome: 'ok', scope: 'project', message: 'Successfully installed' }) : undefined))
    const r = await createExtensionsApi(t.ctx).install('plugin:frontend-design@anthropic-plugin-directory', { scope: 'project', projectPath: project })
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/shared with your team/)
    expect(calls[0].args).toEqual(['plugin', 'install', 'frontend-design@anthropic-plugin-directory', '--scope', 'project', '--json'])
    expect(calls[0].opts?.cwd).toBe(project)
    expect(t.snapshots[0].paths).toContain(join(project, '.claude', 'settings.local.json'))
  })

  it('turns CLI failures into friendly messages', async () => {
    fakeCli((args) => {
      if (args[2] === 'missing@anthropic-plugin-directory')
        return fail({ command: 'install', outcome: 'failed', message: 'Plugin "missing" not found in marketplace', failureCode: 'not_found' })
      if (args[2] === 'already@anthropic-plugin-directory')
        return ok({ command: 'install', outcome: 'ok', message: 'Plugin "already@anthropic-plugin-directory" is already installed (scope: user)' })
      if (args[1] === 'marketplace' && args[2] === 'add')
        return fail({ outcome: 'failed', message: "fatal: cannot create directory at 'plugins/x': Filename too long", failureCode: 'error_unknown' })
      return undefined
    })
    const api = createExtensionsApi(t.ctx)
    const missing = await api.install('missing@anthropic-plugin-directory')
    expect(missing.ok).toBe(false)
    expect(missing.message).toBe('Couldn\'t find "missing" in the anthropic-plugin-directory marketplace. It may have been renamed or removed.')
    expect(missing.details).toMatch(/not found/)
    expect((await api.install('already@anthropic-plugin-directory')).message).toBe('The "already" plugin is already installed.')
    const longPath = await api.install('plugin:x@claude-plugins-official')
    expect(longPath.ok).toBe(false)
    expect(longPath.message).toMatch(/core.longpaths true/)
  })

  it('acts on the installed variant of a plugin listed by several marketplaces', async () => {
    await writePluginsFile('installed_plugins.json', {
      version: 2,
      plugins: { 'frontend-design@anthropic-plugin-directory': [{ scope: 'user', installPath: join(pluginsDir(), 'cache', 'fd') }] }
    })
    fakeCli((args) => (args[1] === 'uninstall' || args[1] === 'disable' ? ok({ outcome: 'ok', message: 'done' }) : undefined))
    const api = createExtensionsApi(t.ctx)
    const again = await api.install('plugin:frontend-design@claude-plugins-official')
    expect(again).toMatchObject({ ok: true, message: 'The "frontend-design" plugin is already installed (from anthropic-plugin-directory).' })
    expect((await api.setEnabled('plugin:frontend-design@claude-plugins-official', false)).ok).toBe(true)
    expect((await api.uninstall('plugin:frontend-design@claude-plugins-official')).ok).toBe(true)
    expect(calls.map((c) => c.args.join(' '))).toEqual([
      'plugin disable frontend-design@anthropic-plugin-directory --scope user --json',
      'plugin uninstall frontend-design@anthropic-plugin-directory --scope user --json'
    ])
  })

  it('uninstalls and switches plugins with the scope they were installed in', async () => {
    const project = join(sb.root, 'proj')
    await mkdir(project, { recursive: true })
    await writePluginsFile('installed_plugins.json', {
      version: 2,
      plugins: {
        'commit-commands@claude-plugins-official': [{ scope: 'user', installPath: join(pluginsDir(), 'cache', 'cc'), version: '1' }],
        'frontend-design@anthropic-plugin-directory': [{ scope: 'project', installPath: join(pluginsDir(), 'cache', 'fd'), projectPath: project }]
      }
    })
    await mkdir(join(sb.home, '.claude'), { recursive: true })
    await writeFile(join(sb.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'commit-commands@claude-plugins-official': false } }))
    await mkdir(join(pluginsDir(), 'cache', 'cc', '.claude-plugin'), { recursive: true })
    await writeFile(join(pluginsDir(), 'cache', 'cc', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'commit-commands', description: 'Git commit helpers', author: { name: 'Anthropic' } }))

    const api = createExtensionsApi(t.ctx)
    const listed = await api.installed('plugin')
    expect(listed).toHaveLength(2)
    const cc = listed.find((p) => p.name === 'commit-commands')!
    expect(cc).toMatchObject({ id: 'plugin:commit-commands@claude-plugins-official', enabled: false, description: 'Git commit helpers', author: 'Anthropic', scope: 'user' })
    const fd = listed.find((p) => p.name === 'frontend-design')!
    expect(fd.scope).toBe('project')
    expect(fd.id.startsWith('plugin:local:project:')).toBe(true)

    fakeCli((args) => {
      const line = args.join(' ')
      if (line.startsWith('plugin enable commit-commands')) return ok({ outcome: 'ok', message: 'Successfully enabled' })
      if (line.startsWith('plugin disable commit-commands'))
        return fail({ outcome: 'failed', message: 'already disabled', failureCode: 'already_in_goal_state', alreadyInGoalState: true })
      if (line.startsWith('plugin uninstall commit-commands')) return fail({ outcome: 'failed', message: 'not found in installed plugins', failureCode: 'not_installed' })
      if (line.startsWith('plugin disable frontend-design')) return ok({ outcome: 'ok', message: 'disabled' })
      if (line.startsWith('plugin uninstall frontend-design')) return ok({ outcome: 'ok', message: 'Successfully uninstalled' })
      return undefined
    })
    expect((await api.setEnabled(cc.id, true)).message).toMatch(/Turned on the "commit-commands" plugin/)
    expect((await api.setEnabled(cc.id, false)).message).toBe('The "commit-commands" plugin is already off.')
    expect((await api.uninstall(cc.id)).message).toBe('The "commit-commands" plugin is not installed.')
    expect((await api.setEnabled(fd.id, false)).ok).toBe(true)
    expect((await api.uninstall(fd.id)).message).toMatch(/Removed the "frontend-design" plugin/)
    expect(calls.map((c) => [c.args.join(' '), c.opts?.cwd])).toEqual([
      ['plugin enable commit-commands@claude-plugins-official --scope user --json', undefined],
      ['plugin disable commit-commands@claude-plugins-official --scope user --json', undefined],
      ['plugin uninstall commit-commands@claude-plugins-official --scope user --json', undefined],
      ['plugin disable frontend-design@anthropic-plugin-directory --scope project --json', project],
      ['plugin uninstall frontend-design@anthropic-plugin-directory --scope project --json', project]
    ])
  })

  it('lists known and suggested marketplaces', async () => {
    await writePluginsFile('known_marketplaces.json', {
      'claude-plugins-official': { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } },
      acme: { source: { source: 'git', url: 'https://github.com/acme/plugins.git' } }
    })
    fakeCli((args) => (args.join(' ') === 'plugin marketplace list --json' ? ok([{ name: 'from-cli', source: 'github', repo: 'x/y' }]) : undefined))
    const list = await createExtensionsApi(t.ctx).marketplaces()
    expect(list[0]).toMatchObject({ name: 'anthropic-plugin-directory', source: 'built-in', added: true, official: true })
    expect(list.find((m) => m.name === 'claude-plugins-official')).toMatchObject({ added: true, official: true, repo: 'anthropics/claude-plugins-official' })
    expect(list.find((m) => m.name === 'acme')).toMatchObject({ added: true, official: false, repo: 'acme/plugins', description: 'Added by you.' })
    expect(list.find((m) => m.name === 'from-cli')).toMatchObject({ added: true, source: 'x/y' })
    expect(list.find((m) => m.name === 'voltagent-subagents')).toMatchObject({ added: false, source: 'VoltAgent/awesome-claude-code-subagents' })
    expect(list.filter((m) => !m.added).length).toBeGreaterThanOrEqual(9)
  })

  it('adds and removes marketplaces, rejecting unsafe input', async () => {
    await writePluginsFile('installed_plugins.json', {
      version: 2,
      plugins: { 'a@acme': [{ scope: 'user' }], 'b@acme': [{ scope: 'user' }], 'c@other': [{ scope: 'user' }] }
    })
    fakeCli((args) => {
      const line = args.join(' ')
      if (line === 'plugin marketplace add acme/plugins --json') return ok({ outcome: 'ok', marketplace: 'acme', message: 'Successfully added marketplace: acme' })
      if (line === 'plugin marketplace remove acme --json') return ok({ outcome: 'ok', marketplace: 'acme', message: 'Successfully removed marketplace' })
      if (line === 'plugin marketplace remove anthropic-plugin-directory --json') return ok('✔ Anthropic Directory is off.')
      return undefined
    })
    const api = createExtensionsApi(t.ctx)
    for (const bad of ['', '--help', 'not a source!', '../relative']) {
      expect((await api.addMarketplace(bad)).ok).toBe(false)
    }
    expect(calls).toHaveLength(0)
    expect((await api.addMarketplace('acme/plugins')).message).toBe('Added the "acme" marketplace. Its plugins now appear in the catalog.')
    expect((await api.removeMarketplace('acme')).message).toBe('Removed the "acme" marketplace and uninstalled its 2 plugins (a, b).')
    expect((await api.removeMarketplace('anthropic-plugin-directory')).message).toMatch(/Turned off Anthropic's plugin directory/)
    expect((await api.removeMarketplace('bad name')).ok).toBe(false)
  })
})
