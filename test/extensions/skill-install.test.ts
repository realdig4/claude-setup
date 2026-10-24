import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@core/platform/runtimes', () => ({ findClaudeCli: vi.fn(async () => null) }))
vi.mock('@core/platform/exec', () => ({ run: vi.fn(), which: vi.fn(async () => '/usr/bin/tool') }))

import { createExtensionsApi } from '@core/extensions'
import { createSandbox, type Sandbox } from '../helpers/sandbox'
import { fakeRepo, fixtureText, jsonResponse, makeCtx, stubFetch, type TestContext } from './helpers'

const PDF_MD = '---\nname: pdf\ndescription: Read, merge and split PDF files.\n---\n# PDF\nUse scripts/merge.py.\n'
const PDF_ID = 'skill:anthropic-skills:anthropics/skills/skills/pdf'

function skillsRepo(extra: Record<string, string> = {}) {
  return fakeRepo('anthropics', 'skills', {
    '.claude-plugin/marketplace.json': fixtureText('marketplace-skills.json'),
    'skills/pdf/SKILL.md': PDF_MD,
    'skills/pdf/scripts/merge.py': { content: 'print("merge")\n', executable: true },
    'skills/pdf/reference.md': '# Reference\n',
    'skills/other/SKILL.md': '---\nname: other\ndescription: Other.\n---\n',
    ...extra
  })
}

describe('skill install', () => {
  let sb: Sandbox
  let t: TestContext

  beforeEach(async () => {
    sb = await createSandbox()
    t = await makeCtx(sb)
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await sb.cleanup()
  })

  const skillDir = () => join(sb.home, '.claude', 'skills', 'pdf')

  it('downloads the folder into ~/.claude/skills/<name> with a backup and a registry record', async () => {
    stubFetch(skillsRepo())
    const api = createExtensionsApi(t.ctx)
    const r = await api.install(PDF_ID, { scope: 'user' })
    expect(r.ok, r.details).toBe(true)
    expect(r.message).toMatch(/Installed the "pdf" skill for all your projects/)
    expect(r.message).toMatch(/reload-skills/)
    expect(r.backupId).toBe('backup-1')
    expect(readFileSync(join(skillDir(), 'SKILL.md'), 'utf8')).toBe(PDF_MD)
    expect(readFileSync(join(skillDir(), 'scripts', 'merge.py'), 'utf8')).toBe('print("merge")\n')
    expect(existsSync(join(skillDir(), 'reference.md'))).toBe(true)
    expect(existsSync(join(sb.home, '.claude', 'skills', 'other'))).toBe(false)
    expect(t.snapshots[0].paths.sort()).toEqual(
      [join(skillDir(), 'SKILL.md'), join(skillDir(), 'scripts', 'merge.py'), join(skillDir(), 'reference.md')].sort()
    )
    expect(t.snapshots[0].existed.every((e) => !e)).toBe(true)
    const registry = JSON.parse(readFileSync(join(sb.dataDir, 'extensions-installs.json'), 'utf8'))
    expect(registry.records[0]).toMatchObject({ id: PDF_ID, kind: 'skill', scope: 'user', path: skillDir() })
    expect(registry.records[0].files).toHaveLength(3)
    expect(t.progress.some((m) => m.includes('Downloading skill files'))).toBe(true)
    // no staging leftovers
    const staging = join(sb.dataDir, 'cache', 'extensions', 'staging')
    expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([])

    const installed = await api.installed('skill')
    expect(installed).toHaveLength(1)
    expect(installed[0]).toMatchObject({ id: 'skill:local:user:pdf', name: 'pdf', installed: true, scope: 'user', enabled: true, source: 'anthropic-skills' })
  })

  it('updates its own install but never overwrites a different skill', async () => {
    stubFetch(skillsRepo())
    const api = createExtensionsApi(t.ctx)
    expect((await api.install(PDF_ID)).ok).toBe(true)
    const again = await api.install(PDF_ID)
    expect(again.ok).toBe(true)
    expect(again.message).toMatch(/^Updated the "pdf" skill/)
    expect(t.snapshots[1].existed.every((e) => e)).toBe(true)

    // someone else's skill with the same folder name
    const sb2 = await createSandbox()
    try {
      const t2 = await makeCtx(sb2)
      const own = join(sb2.home, '.claude', 'skills', 'pdf')
      await mkdir(own, { recursive: true })
      await writeFile(join(own, 'SKILL.md'), '---\nname: pdf\ndescription: mine\n---\n')
      const r = await createExtensionsApi(t2.ctx).install(PDF_ID)
      expect(r.ok).toBe(false)
      expect(r.message).toMatch(/A different skill named "pdf" is already installed/)
      expect(await readFile(join(own, 'SKILL.md'), 'utf8')).toContain('mine')
      expect(t2.snapshots).toHaveLength(0)
    } finally {
      await sb2.cleanup()
    }
  })

  it('adopts an identical existing copy', async () => {
    stubFetch(skillsRepo())
    await mkdir(join(skillDir(), 'scripts'), { recursive: true })
    await writeFile(join(skillDir(), 'SKILL.md'), PDF_MD)
    await writeFile(join(skillDir(), 'scripts', 'merge.py'), 'print("merge")\n')
    await writeFile(join(skillDir(), 'reference.md'), '# Reference\n')
    const r = await createExtensionsApi(t.ctx).install(PDF_ID)
    expect(r).toMatchObject({ ok: true, message: 'The "pdf" skill is already installed.' })
  })

  it('refuses skills that are too big, unsafe or not skills at all', async () => {
    const big: Record<string, string> = { 'skills/big/SKILL.md': PDF_MD }
    for (let i = 0; i < 201; i++) big[`skills/big/f${i}.txt`] = 'x'
    stubFetch(
      skillsRepo({
        ...big,
        'skills/evil/SKILL.md': PDF_MD,
        'skills/evil/../../escape.txt': 'nope',
        'skills/empty/readme.md': 'no skill here'
      })
    )
    const api = createExtensionsApi(t.ctx)
    const tooBig = await api.install('skill:anthropic-skills:anthropics/skills/skills/big')
    expect(tooBig.ok).toBe(false)
    expect(tooBig.message).toMatch(/too large to install safely \(202 files/)
    const evil = await api.install('skill:anthropic-skills:anthropics/skills/skills/evil')
    expect(evil.ok).toBe(false)
    expect(evil.message).toMatch(/can't be saved safely/)
    const notSkill = await api.install('skill:anthropic-skills:anthropics/skills/skills/empty')
    expect(notSkill.ok).toBe(false)
    expect(notSkill.message).toMatch(/doesn't contain a SKILL.md/)
    expect(existsSync(join(sb.home, '.claude', 'skills'))).toBe(false)
    expect(existsSync(join(sb.root, 'escape.txt'))).toBe(false)
  })

  it('finds a skills.sh skill by its id inside the repository', async () => {
    stubFetch(
      fakeRepo('acme', 'agent-skills', {
        'README.md': '# Skills',
        'skills/react-components/SKILL.md': '---\nname: react:components\ndescription: Build React components.\n---\n',
        'skills/react-components/examples/button.tsx': 'export {}\n',
        'skills/vue/SKILL.md': '---\nname: vue\ndescription: Vue.\n---\n'
      })
    )
    const r = await createExtensionsApi(t.ctx).install('skill:skills.sh:acme/agent-skills/reactcomponents')
    expect(r.ok, r.details).toBe(true)
    const dir = join(sb.home, '.claude', 'skills', 'react-components')
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dir, 'examples', 'button.tsx'))).toBe(true)
  })

  it('installs into a project and remembers the project', async () => {
    stubFetch(skillsRepo())
    const project = join(sb.root, 'my-app')
    await mkdir(project, { recursive: true })
    const api = createExtensionsApi(t.ctx)
    const r = await api.install(PDF_ID, { scope: 'project', projectPath: project })
    expect(r.ok, r.details).toBe(true)
    expect(r.message).toMatch(/for the project "my-app"/)
    expect(existsSync(join(project, '.claude', 'skills', 'pdf', 'SKILL.md'))).toBe(true)
    expect(t.ctx.state.settings().recentProjects[0]).toBe(project)
    const installed = await api.installed('skill')
    expect(installed[0]).toMatchObject({ scope: 'project', name: 'pdf' })
    const missing = await api.install(PDF_ID, { scope: 'project', projectPath: join(sb.root, 'nope') })
    expect(missing).toMatchObject({ ok: false, message: "That project folder doesn't exist." })
  })

  it('explains GitHub rate limits', async () => {
    stubFetch((url) => (url.hostname === 'api.github.com' ? jsonResponse({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' }) : undefined))
    const r = await createExtensionsApi(t.ctx).install(PDF_ID)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/GitHub's download limit was reached/)
    expect(r.message).toMatch(/GitHub token/)
  })

  it('warns when SKILL.md has no description', async () => {
    stubFetch(skillsRepo({ 'skills/bare/SKILL.md': '# no header\n' }))
    const r = await createExtensionsApi(t.ctx).install('skill:anthropic-skills:anthropics/skills/skills/bare')
    expect(r.ok).toBe(true)
    expect(r.details).toMatch(/no header/)
  })

  it('switches a skill off and on with skillOverrides, and removes it with a backup', async () => {
    stubFetch(skillsRepo())
    const api = createExtensionsApi(t.ctx)
    await api.install(PDF_ID)
    const off = await api.setEnabled('skill:local:user:pdf', false)
    expect(off.ok, off.details).toBe(true)
    const settingsFile = join(sb.home, '.claude', 'settings.json')
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({ skillOverrides: { pdf: 'off' } })
    expect((await api.installed('skill'))[0].enabled).toBe(false)
    expect((await api.setEnabled('skill:local:user:pdf', false)).message).toMatch(/already off/)
    const on = await api.setEnabled(PDF_ID, true)
    expect(on.ok).toBe(true)
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({})

    await api.setEnabled('skill:local:user:pdf', false)
    const before = t.snapshots.length
    const removed = await api.uninstall('skill:local:user:pdf')
    expect(removed.ok, removed.details).toBe(true)
    expect(existsSync(skillDir())).toBe(false)
    const snap = t.snapshots[before]
    expect(snap.paths).toContain(join(skillDir(), 'SKILL.md'))
    expect(snap.paths).toContain(settingsFile)
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({})
    expect(JSON.parse(readFileSync(join(sb.dataDir, 'extensions-installs.json'), 'utf8')).records).toHaveLength(0)
    expect((await api.uninstall('skill:local:user:pdf')).ok).toBe(false)
  })

  it('uninstalls by catalog id through the registry', async () => {
    stubFetch(skillsRepo())
    const api = createExtensionsApi(t.ctx)
    await api.install(PDF_ID)
    const r = await api.uninstall(PDF_ID)
    expect(r.ok).toBe(true)
    expect(existsSync(skillDir())).toBe(false)
  })
})
