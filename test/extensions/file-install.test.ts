import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@core/platform/runtimes', () => ({ findClaudeCli: vi.fn(async () => null) }))
vi.mock('@core/platform/exec', () => ({ run: vi.fn(), which: vi.fn(async () => '/usr/bin/tool') }))

import { createExtensionsApi } from '@core/extensions'
import { createSandbox, type Sandbox } from '../helpers/sandbox'
import { fakeRepo, makeCtx, stubFetch, type TestContext } from './helpers'

const AGENT = '---\nname: accessibility-tester\ndescription: "Audits UI for WCAG issues."\ntools: Read, Grep\n---\nYou are an accessibility expert.\n'
const COMMAND = '---\ndescription: Execute GitHub Actions locally using act\nargument-hint: [workflow-name]\n---\nRun act for $ARGUMENTS\n'
const STYLE = '---\nname: Teacher\ndescription: Explains as it goes\n---\nExplain your reasoning.\n'
const BASE = 'cli-tool/components'
const AGENT_ID = `agent:aitmpl:davila7/claude-code-templates/${BASE}/agents/accessibility/accessibility-tester.md`
const COMMAND_ID = `command:aitmpl:davila7/claude-code-templates/${BASE}/commands/automation/act.md`
const STYLE_ID = `output-style:aitmpl:davila7/claude-code-templates/${BASE}/output-styles/teacher.md`

function repo() {
  return fakeRepo('davila7', 'claude-code-templates', {
    [`${BASE}/agents/accessibility/accessibility-tester.md`]: AGENT,
    [`${BASE}/agents/broken/no-description.md`]: '---\nname: broken\n---\nbody\n',
    [`${BASE}/commands/automation/act.md`]: COMMAND,
    [`${BASE}/output-styles/teacher.md`]: STYLE
  })
}

describe('agents, commands and output styles', () => {
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

  const agentFile = () => join(sb.home, '.claude', 'agents', 'accessibility-tester.md')

  it('installs an agent with its original file name', async () => {
    const api = createExtensionsApi(t.ctx)
    const r = await api.install(AGENT_ID)
    expect(r.ok, r.details).toBe(true)
    expect(r.message).toMatch(/Installed the "accessibility-tester" agent for all your projects/)
    expect(r.message).toMatch(/Restart Claude Code/)
    expect(readFileSync(agentFile(), 'utf8')).toBe(AGENT)
    expect(t.snapshots[0]).toMatchObject({ paths: [agentFile()], existed: [false] })
    const second = await api.install(AGENT_ID)
    expect(second.message).toBe('The "accessibility-tester" agent is already installed.')
    const list = await api.installed('agent')
    expect(list).toEqual([
      expect.objectContaining({
        id: 'agent:local:user:accessibility-tester.md',
        name: 'accessibility-tester',
        description: 'Audits UI for WCAG issues.',
        enabled: true,
        source: 'aitmpl',
        installedPath: agentFile()
      })
    ])
  })

  it('installs commands and output styles into their folders', async () => {
    const api = createExtensionsApi(t.ctx)
    const c = await api.install(COMMAND_ID)
    expect(c.ok).toBe(true)
    expect(c.message).toMatch(/type \/act/)
    expect(readFileSync(join(sb.home, '.claude', 'commands', 'act.md'), 'utf8')).toBe(COMMAND)
    const s = await api.install(STYLE_ID)
    expect(s.ok).toBe(true)
    expect(s.message).toMatch(/\/output-style Teacher/)
    expect(existsSync(join(sb.home, '.claude', 'output-styles', 'teacher.md'))).toBe(true)
    const commands = await api.installed('command')
    expect(commands[0]).toMatchObject({ name: '/act', description: 'Execute GitHub Actions locally using act' })
  })

  it('never overwrites a different file it did not install', async () => {
    await mkdir(join(sb.home, '.claude', 'agents'), { recursive: true })
    await writeFile(agentFile(), '---\nname: accessibility-tester\ndescription: my own\n---\n')
    const r = await createExtensionsApi(t.ctx).install(AGENT_ID)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/A different agent file named "accessibility-tester.md" already exists/)
    expect(readFileSync(agentFile(), 'utf8')).toContain('my own')
  })

  it('warns about agents Claude Code would skip', async () => {
    const r = await createExtensionsApi(t.ctx).install(`agent:aitmpl:davila7/claude-code-templates/${BASE}/agents/broken/no-description.md`)
    expect(r.ok).toBe(true)
    expect(r.details).toMatch(/missing a name or description/)
  })

  it('switches files off and on by renaming, and uninstalls them', async () => {
    const api = createExtensionsApi(t.ctx)
    await api.install(AGENT_ID)
    const off = await api.setEnabled('agent:local:user:accessibility-tester.md', false)
    expect(off.ok, off.details).toBe(true)
    expect(existsSync(agentFile())).toBe(false)
    expect(existsSync(agentFile() + '.disabled')).toBe(true)
    expect(t.snapshots.at(-1)).toMatchObject({ paths: [agentFile(), agentFile() + '.disabled'], existed: [true, false] })
    const listed = await api.installed('agent')
    expect(listed[0]).toMatchObject({ id: 'agent:local:user:accessibility-tester.md', enabled: false })
    const reinstall = await api.install(AGENT_ID)
    expect(reinstall.ok).toBe(false)
    expect(reinstall.message).toMatch(/switched off/)
    expect((await api.setEnabled(AGENT_ID, true)).ok).toBe(true)
    expect(existsSync(agentFile())).toBe(true)
    expect((await api.setEnabled(AGENT_ID, true)).message).toMatch(/already on/)

    const removed = await api.uninstall(AGENT_ID)
    expect(removed.ok).toBe(true)
    expect(existsSync(agentFile())).toBe(false)
    expect(t.snapshots.at(-1)?.paths).toEqual([agentFile()])
    expect(await api.installed('agent')).toEqual([])
  })

  it('handles nested files and project scope', async () => {
    const project = join(sb.root, 'proj')
    const nested = join(project, '.claude', 'commands', 'frontend')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'component.md'), '---\ndescription: Make a component\n---\nDo it.\n')
    await t.ctx.state.update((d) => void (d.settings.recentProjects = [project]))
    const api = createExtensionsApi(t.ctx)
    const list = await api.installed('command')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: '/frontend:component', scope: 'project', source: 'local' })
    const off = await api.setEnabled(list[0].id, false)
    expect(off.ok, off.details).toBe(true)
    expect(existsSync(join(nested, 'component.md.disabled'))).toBe(true)
    const r = await api.uninstall(list[0].id)
    expect(r.ok).toBe(true)
    expect(existsSync(join(nested, 'component.md.disabled'))).toBe(false)

    const inProject = await api.install(AGENT_ID, { scope: 'project', projectPath: project })
    expect(inProject.ok).toBe(true)
    expect(existsSync(join(project, '.claude', 'agents', 'accessibility-tester.md'))).toBe(true)
  })

  it('rejects invalid ids and unknown items', async () => {
    const api = createExtensionsApi(t.ctx)
    expect((await api.install('agent:aitmpl:davila7/claude-code-templates/../../x.md')).message).toMatch(/isn't valid/)
    const missing = await api.install(`agent:aitmpl:davila7/claude-code-templates/${BASE}/agents/none.md`)
    expect(missing.ok).toBe(false)
    expect(missing.message).toMatch(/Couldn't find this agent on GitHub/)
    expect((await api.uninstall('agent:local:user:nothing.md')).ok).toBe(false)
  })
})
