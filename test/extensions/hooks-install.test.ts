import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@core/platform/runtimes', () => ({ findClaudeCli: vi.fn(async () => null) }))
vi.mock('@core/platform/exec', () => ({ run: vi.fn(), which: vi.fn(async () => '/usr/bin/tool') }))

import { createExtensionsApi } from '@core/extensions'
import { adaptForPlatform } from '@core/extensions/installers/scripts'
import type { HooksMap } from '@core/extensions/settingsMerge'
import { createSandbox, type Sandbox } from '../helpers/sandbox'
import { fakeRepo, fixtureText, makeCtx, stubFetch, type TestContext } from './helpers'

const C = 'cli-tool/components'
const REPO = 'davila7/claude-code-templates'
const PROTECT_ID = `hook:aitmpl:${REPO}/${C}/hooks/security/file-protection.json`
const LOGGER_ID = `hook:aitmpl:${REPO}/${C}/hooks/automation/change-logger.json`
const COLORFUL_ID = `statusline:aitmpl:${REPO}/${C}/settings/statusline/colorful-statusline.json`
const MONITOR_ID = `statusline:aitmpl:${REPO}/${C}/settings/statusline/context-monitor.json`

function repo() {
  return fakeRepo('davila7', 'claude-code-templates', {
    [`${C}/hooks/security/file-protection.json`]: fixtureText('hook-security-file-protection.json'),
    [`${C}/hooks/automation/change-logger.json`]: fixtureText('hook-automation-change-logger.json'),
    [`${C}/hooks/automation/change-logger.py`]: { content: 'print("log")\n', executable: true },
    [`${C}/settings/statusline/colorful-statusline.json`]: fixtureText('statusline-colorful-statusline.json'),
    [`${C}/settings/statusline/context-monitor.json`]: fixtureText('statusline-context-monitor.json'),
    [`${C}/settings/statusline/context-monitor.py`]: 'print("ctx")\n',
    [`${C}/hooks/broken/bad.json`]: '{ not json'
  })
}

describe('hooks and status lines', () => {
  let sb: Sandbox
  let t: TestContext
  beforeEach(async () => {
    sb = await createSandbox()
    t = await makeCtx(sb)
    stubFetch(repo())
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await sb.cleanup()
  })

  const settingsFile = () => join(sb.home, '.claude', 'settings.json')
  const readSettings = () => JSON.parse(readFileSync(settingsFile(), 'utf8'))
  const writeUserSettings = async (data: unknown) => {
    await mkdir(join(sb.home, '.claude'), { recursive: true })
    await writeFile(settingsFile(), JSON.stringify(data, null, 2))
  }

  it('merges a hook into user settings with a backup and a warning', async () => {
    await writeUserSettings({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } })
    const api = createExtensionsApi(t.ctx)
    const r = await api.install(PROTECT_ID)
    expect(r.ok, r.details).toBe(true)
    expect(r.message).toMatch(/Installed the "file-protection" hook in your user settings/)
    expect(r.details).toMatch(/run commands on your computer/)
    expect(t.snapshots[0].paths).toEqual([settingsFile()])
    const s = readSettings()
    expect(s.model).toBe('opus')
    expect(s.hooks.Stop).toHaveLength(1)
    expect(s.hooks.PreToolUse[0].matcher).toBe('Edit|MultiEdit|Write')
    const listed = await api.installed('hook')
    expect(listed).toHaveLength(2)
    const ours = listed.find((i) => i.name === 'file-protection')
    expect(ours?.id).toMatch(/^hook:local:user:rec-[a-f0-9]{8}$/)
    expect(listed.find((i) => i.name !== 'file-protection')?.id).toMatch(/^hook:local:user:Stop\/[a-f0-9]{12}$/)
  })

  it('downloads hook scripts and points user-scope commands at ~/.claude', async () => {
    const api = createExtensionsApi(t.ctx)
    const r = await api.install(LOGGER_ID)
    expect(r.ok, r.details).toBe(true)
    expect(readFileSync(join(sb.home, '.claude', 'hooks', 'change-logger.py'), 'utf8')).toBe('print("log")\n')
    const groups = (readSettings().hooks as HooksMap).PostToolUse
    expect(groups.map((g) => g.matcher)).toEqual(['Edit', 'Write', 'MultiEdit', 'Bash'])
    expect(groups[0].hooks[0].command).toBe(adaptForPlatform('python3 "$HOME/.claude/hooks/change-logger.py"'))
    expect(t.snapshots[0].paths).toEqual([settingsFile(), join(sb.home, '.claude', 'hooks', 'change-logger.py')])

    const again = await api.install(LOGGER_ID)
    expect(again.message).toMatch(/^Updated the "change-logger" hook/)
    expect((readSettings().hooks as HooksMap).PostToolUse.every((g) => g.hooks.length === 1)).toBe(true)

    const removed = await api.uninstall(LOGGER_ID)
    expect(removed.ok, removed.details).toBe(true)
    expect(existsSync(join(sb.home, '.claude', 'hooks', 'change-logger.py'))).toBe(false)
    expect(readSettings().hooks).toBeUndefined()
  })

  it('installs into project and local settings without rewriting project paths', async () => {
    const project = join(sb.root, 'app')
    await mkdir(project, { recursive: true })
    const api = createExtensionsApi(t.ctx)
    const r = await api.install(LOGGER_ID, { scope: 'project', projectPath: project })
    expect(r.ok, r.details).toBe(true)
    expect(r.details).toMatch(/trust the project folder/)
    const s = JSON.parse(readFileSync(join(project, '.claude', 'settings.json'), 'utf8'))
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe(adaptForPlatform('python3 .claude/hooks/change-logger.py'))
    expect(existsSync(join(project, '.claude', 'hooks', 'change-logger.py'))).toBe(true)
    const local = await api.install(PROTECT_ID, { scope: 'local', projectPath: project })
    expect(local.ok).toBe(true)
    expect(local.message).toMatch(/settings.local.json/)
    expect(existsSync(join(project, '.claude', 'settings.local.json'))).toBe(true)
    const listed = await api.installed('hook')
    expect(listed.map((i) => i.scope).sort()).toEqual(['local', 'project'])
  })

  it('does not take over identical hooks the user already has', async () => {
    const own = JSON.parse(fixtureText('hook-security-file-protection.json')).hooks
    await writeUserSettings({ hooks: own })
    const r = await createExtensionsApi(t.ctx).install(PROTECT_ID)
    expect(r).toMatchObject({ ok: true })
    expect(r.message).toMatch(/already set up/)
    expect(readSettings().hooks).toEqual(own)
  })

  it('switches our hook off and on, and parks the user’s own hooks too', async () => {
    await writeUserSettings({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } })
    const api = createExtensionsApi(t.ctx)
    await api.install(PROTECT_ID)
    const ours = (await api.installed('hook')).find((i) => i.name === 'file-protection')!
    expect((await api.setEnabled(ours.id, false)).ok).toBe(true)
    expect(readSettings().hooks.PreToolUse).toBeUndefined()
    expect((await api.installed('hook')).find((i) => i.name === 'file-protection')?.enabled).toBe(false)
    expect((await api.setEnabled(PROTECT_ID, true)).ok).toBe(true)
    expect(readSettings().hooks.PreToolUse).toHaveLength(1)

    const mine = (await api.installed('hook')).find((i) => i.name !== 'file-protection')!
    const off = await api.setEnabled(mine.id, false)
    expect(off.ok, off.details).toBe(true)
    expect(readSettings().hooks.Stop).toBeUndefined()
    const parked = (await api.installed('hook')).find((i) => i.name === mine.name)!
    expect(parked).toMatchObject({ enabled: false })
    expect(parked.id).toMatch(/rec-/)
    expect((await api.setEnabled(parked.id, true)).ok).toBe(true)
    expect(readSettings().hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'say done' }] }])
    const records = JSON.parse(readFileSync(join(sb.dataDir, 'extensions-installs.json'), 'utf8')).records
    expect(records.map((r: { name: string }) => r.name)).toEqual(['file-protection'])
  })

  it('installs a status line, remembers the previous one and restores it', async () => {
    await writeUserSettings({ statusLine: { type: 'command', command: 'my-status' } })
    const api = createExtensionsApi(t.ctx)
    const r = await api.install(COLORFUL_ID)
    expect(r.ok, r.details).toBe(true)
    expect(r.details).toMatch(/previous status line is remembered/)
    expect(readSettings().statusLine.command).toMatch(/^bash -c/)
    const listed = await api.installed('statusline')
    expect(listed).toEqual([expect.objectContaining({ id: 'statusline:local:user:statusLine', name: 'colorful-statusline', enabled: true })])
    const removed = await api.uninstall('statusline:local:user:statusLine')
    expect(removed.message).toMatch(/put your previous one back/)
    expect(readSettings().statusLine).toEqual({ type: 'command', command: 'my-status' })
  })

  it('chains replacements so the original status line comes back', async () => {
    await writeUserSettings({ statusLine: { type: 'command', command: 'original' } })
    const api = createExtensionsApi(t.ctx)
    await api.install(COLORFUL_ID)
    const r = await api.install(MONITOR_ID)
    expect(r.ok, r.details).toBe(true)
    const script = join(sb.home, '.claude', 'scripts', 'context-monitor.py')
    expect(readFileSync(script, 'utf8')).toBe('print("ctx")\n')
    expect(readSettings().statusLine.command).toBe(adaptForPlatform('python3 "$HOME/.claude/scripts/context-monitor.py"'))
    const records = JSON.parse(readFileSync(join(sb.dataDir, 'extensions-installs.json'), 'utf8')).records
    expect(records).toHaveLength(1)
    expect(records[0].statusLine.previous).toEqual({ type: 'command', command: 'original' })
    await api.uninstall(MONITOR_ID)
    expect(readSettings().statusLine).toEqual({ type: 'command', command: 'original' })
    expect(existsSync(script)).toBe(false)
  })

  it('switches a status line off and back on', async () => {
    const api = createExtensionsApi(t.ctx)
    await api.install(COLORFUL_ID)
    expect((await api.setEnabled('statusline:local:user:statusLine', false)).ok).toBe(true)
    expect(readSettings().statusLine).toBeUndefined()
    const parked = (await api.installed('statusline'))[0]
    expect(parked).toMatchObject({ enabled: false, name: 'colorful-statusline' })
    await writeUserSettings({ statusLine: { type: 'command', command: 'other' } })
    const blocked = await api.setEnabled(parked.id, true)
    expect(blocked).toMatchObject({ ok: false })
    await writeUserSettings({})
    expect((await api.setEnabled(parked.id, true)).ok).toBe(true)
    expect(readSettings().statusLine.command).toMatch(/^bash -c/)
  })

  it('refuses to touch an unreadable settings file or a broken download', async () => {
    await mkdir(join(sb.home, '.claude'), { recursive: true })
    await writeFile(settingsFile(), '{ "model": "opus", // comment\n}')
    const api = createExtensionsApi(t.ctx)
    const r = await api.install(PROTECT_ID)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/formatting problem/)
    expect(readFileSync(settingsFile(), 'utf8')).toContain('// comment')
    const bad = await api.install(`hook:aitmpl:${REPO}/${C}/hooks/broken/bad.json`)
    expect(bad).toMatchObject({ ok: false, message: "This hook file is not valid JSON, so it wasn't installed." })
  })
})
