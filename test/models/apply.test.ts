import { lstat, mkdir, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyProfile, resetModels } from '@core/models/apply'
import { readMarker } from '@core/models/marker'
import { keyHelperShimPath } from '@core/models/ownedKeys'
import { saveProfile } from '@core/models/profiles'
import { ANTHROPIC_CAVEAT } from '@core/models/providers'
import { claudeJsonPath, claudeUserSettingsPath, vscodeUserDir } from '@core/platform/paths'
import { withSandbox } from '../helpers/sandbox'
import { cleanModelEnv, fakeProxy, makeContext, readJsonFile, writeText } from './helpers'

type Settings = { env?: Record<string, string>; [key: string]: unknown }
type VsEntry = { name: string; value: string }

const VS_SETTINGS = `{
  // my comment survives
  "editor.fontSize": 14,
  "claudeCode.environmentVariables": [
    { "name": "MY_VAR", "value": "1" },
    { "name": "ANTHROPIC_BASE_URL", "value": "https://stale.example" }
  ],
}
`

const vsPath = () => join(vscodeUserDir('Code'), 'settings.json')

async function seedFiles(extra: Record<string, unknown> = {}): Promise<void> {
  await writeText(
    claudeUserSettingsPath(),
    JSON.stringify(
      {
        permissions: { allow: ['Bash(npm test)'] },
        env: { FOO: 'bar', ANTHROPIC_API_KEY: 'old-key', ANTHROPIC_SMALL_FAST_MODEL: 'old', CLAUDE_CODE_EFFORT_LEVEL: 'low' },
        model: 'opus',
        ...extra
      },
      null,
      2
    )
  )
  await writeText(claudeJsonPath(), JSON.stringify({ projects: { 'C:/work': { mcpServers: {} } }, mcpServers: { fs: { type: 'stdio', command: 'npx' } } }))
  await writeText(vsPath(), VS_SETTINGS)
}

async function readVs(): Promise<{ text: string; data: Record<string, unknown>; env: VsEntry[] }> {
  const text = await readFile(vsPath(), 'utf8')
  const data = parseJsonc(text) as Record<string, unknown>
  return { text, data, env: (data['claudeCode.environmentVariables'] as VsEntry[] | undefined) ?? [] }
}

let restoreEnv: () => void
beforeEach(() => {
  restoreEnv = cleanModelEnv()
})
afterEach(() => restoreEnv())

describe('apply / reset', () => {
  it('writes a complete model setup to Claude Code and VS Code, preserving everything else', async () => {
    await withSandbox(async (sb) => {
      const { ctx, backups } = await makeContext(sb)
      await seedFiles()
      const before = await readFile(claudeUserSettingsPath(), 'utf8')
      const p = await saveProfile(ctx, { name: 'Kimi', providerId: 'moonshot', apiKey: 'sk-moon', models: { main: 'kimi-k3[1m]' } })
      const res = await applyProfile(ctx, fakeProxy(), { profileId: p.id, targets: ['claude-code', 'vscode'] })

      expect(res.ok).toBe(true)
      expect(res.results.map((r) => [r.target, r.ok])).toEqual([
        ['claude-code', true],
        ['vscode', true]
      ])
      expect(res.results.every((r) => r.backupId)).toBe(true)
      expect(res.warnings).toContain(ANTHROPIC_CAVEAT)
      expect(res.warnings.some((w) => /Restart Claude Code/.test(w))).toBe(true)
      expect(res.warnings.some((w) => /Reload VS Code/.test(w))).toBe(true)

      const s = await readJsonFile<Settings>(claudeUserSettingsPath())
      const env = s.env!
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic')
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-moon')
      expect('ANTHROPIC_API_KEY' in env).toBe(false)
      expect('ANTHROPIC_SMALL_FAST_MODEL' in env).toBe(false)
      expect(env.FOO).toBe('bar')
      for (const k of [
        'ANTHROPIC_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL',
        'ANTHROPIC_DEFAULT_FABLE_MODEL',
        'CLAUDE_CODE_SUBAGENT_MODEL'
      ]) {
        expect(env[k]).toBe('kimi-k3[1m]')
      }
      expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME).toBe('Kimi K3')
      expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max')
      expect(env.ENABLE_TOOL_SEARCH).toBe('false')
      expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe('1')
      expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0')
      expect(env.API_TIMEOUT_MS).toBe('3000000')
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000')
      expect('CLAUDE_CODE_MAX_CONTEXT_TOKENS' in env).toBe(false)
      for (const v of Object.values(env)) expect(typeof v).toBe('string')
      expect(s.skipWebFetchPreflight).toBe(true)
      expect(s.permissions).toEqual({ allow: ['Bash(npm test)'] })
      expect(s.model).toBe('opus')

      const cj = await readJsonFile(claudeJsonPath())
      expect(cj.hasCompletedOnboarding).toBe(true)
      expect(cj.projects).toEqual({ 'C:/work': { mcpServers: {} } })
      expect(cj.mcpServers).toEqual({ fs: { type: 'stdio', command: 'npx' } })

      const vs = await readVs()
      expect(vs.text).toContain('// my comment survives')
      expect(vs.data['editor.fontSize']).toBe(14)
      expect(vs.data['claudeCode.disableLoginPrompt']).toBe(true)
      expect(vs.env.filter((e) => e.name === 'ANTHROPIC_BASE_URL')).toEqual([{ name: 'ANTHROPIC_BASE_URL', value: 'https://api.moonshot.ai/anthropic' }])
      expect(vs.env.find((e) => e.name === 'MY_VAR')).toEqual({ name: 'MY_VAR', value: '1' })
      expect(vs.env.find((e) => e.name === 'ANTHROPIC_AUTH_TOKEN')?.value).toBe('sk-moon')
      expect(vs.env.find((e) => e.name === 'ANTHROPIC_MODEL')?.value).toBe('kimi-k3[1m]')

      expect(backups.snapshots[0].paths).toEqual([claudeUserSettingsPath()])
      expect(backups.snapshots[0].contents[claudeUserSettingsPath()]).toBe(before)
      expect(backups.snapshots[1].paths).toEqual([vsPath()])
      // ~/.claude.json gets its own backup, only because it changed (the first-run flag).
      expect(backups.snapshots[2].paths).toEqual([claudeJsonPath()])
      expect(ctx.state.get().activeProfileId).toBe(p.id)
      expect(readMarker(ctx).claudeCode?.settings.skipWebFetchPreflight).toBeTruthy()
      expect(await readFile(join(sb.dataDir, 'state.json'), 'utf8')).not.toContain('sk-moon')
    })
  })

  it('reset removes only what Claude Setup owns', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      await seedFiles()
      const p = await saveProfile(ctx, { name: 'Kimi', providerId: 'moonshot', apiKey: 'sk-moon', models: { main: 'kimi-k3[1m]' } })
      await applyProfile(ctx, fakeProxy(), { profileId: p.id, targets: ['claude-code', 'vscode'] })
      const res = await resetModels(ctx, ['claude-code', 'vscode'])
      expect(res.ok).toBe(true)
      expect(res.results.every((r) => r.ok)).toBe(true)

      const s = await readJsonFile<Settings>(claudeUserSettingsPath())
      expect(s.env).toEqual({ FOO: 'bar' })
      expect('skipWebFetchPreflight' in s).toBe(false)
      expect(s.permissions).toEqual({ allow: ['Bash(npm test)'] })
      expect(s.model).toBe('opus')

      const vs = await readVs()
      expect(vs.text).toContain('// my comment survives')
      expect(vs.env).toEqual([{ name: 'MY_VAR', value: '1' }])
      expect('claudeCode.disableLoginPrompt' in vs.data).toBe(false)
      expect(ctx.state.get().activeProfileId).toBeUndefined()
      expect(readMarker(ctx).claudeCode).toBeUndefined()

      const again = await resetModels(ctx, ['claude-code', 'vscode'])
      expect(again.ok).toBe(true)
      expect(again.results.every((r) => /nothing to remove/.test(r.message))).toBe(true)
    })
  })

  it("keeps the user's own skipWebFetchPreflight and disableLoginPrompt", async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      await seedFiles({ skipWebFetchPreflight: true })
      await writeText(vsPath(), '{ "claudeCode.disableLoginPrompt": true }')
      const p = await saveProfile(ctx, { name: 'Kimi', providerId: 'moonshot', apiKey: 'sk-moon', models: { main: 'kimi-k3[1m]' } })
      await applyProfile(ctx, fakeProxy(), { profileId: p.id, targets: ['claude-code', 'vscode'] })
      await resetModels(ctx, ['claude-code', 'vscode'])
      const s = await readJsonFile<Settings>(claudeUserSettingsPath())
      expect(s.skipWebFetchPreflight).toBe(true)
      expect((await readVs()).data['claudeCode.disableLoginPrompt']).toBe(true)
    })
  })

  it('writes through a symlinked settings.json instead of replacing the link', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const real = join(sb.root, 'dotfiles', 'claude-settings.json')
      await writeText(real, JSON.stringify({ env: { FOO: 'bar' } }))
      await mkdir(join(sb.home, '.claude'), { recursive: true })
      try {
        await symlink(real, claudeUserSettingsPath(), 'file')
      } catch {
        return // creating symlinks needs extra rights on some Windows setups
      }
      const p = await saveProfile(ctx, { name: 'Kimi', providerId: 'moonshot', apiKey: 'sk-moon', models: { main: 'kimi-k3[1m]' } })
      const res = await applyProfile(ctx, fakeProxy(), { profileId: p.id, targets: ['claude-code'] })
      expect(res.ok).toBe(true)
      expect((await lstat(claudeUserSettingsPath())).isSymbolicLink()).toBe(true)
      const env = (await readJsonFile<Settings>(real)).env!
      expect(env.FOO).toBe('bar')
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic')
    })
  })

  it('refuses to touch an unreadable settings.json', async () => {
    await withSandbox(async (sb) => {
      const { ctx, backups } = await makeContext(sb)
      await writeText(claudeUserSettingsPath(), '{ "env": { // comment\n } }')
      const p = await saveProfile(ctx, { name: 'Kimi', providerId: 'moonshot', apiKey: 'sk-moon', models: { main: 'kimi-k3[1m]' } })
      const res = await applyProfile(ctx, fakeProxy(), { profileId: p.id, targets: ['claude-code'] })
      expect(res.ok).toBe(false)
      expect(res.results[0].message).toMatch(/can't be read/)
      expect(await readFile(claudeUserSettingsPath(), 'utf8')).toBe('{ "env": { // comment\n } }')
      expect(backups.snapshots).toHaveLength(0)
      expect(ctx.state.get().activeProfileId).toBeUndefined()
    })
  })

  it('does not write when the backup fails', async () => {
    await withSandbox(async (sb) => {
      const { ctx, backups } = await makeContext(sb)
      await seedFiles()
      backups.failWith = 'disk full'
      const before = await readFile(claudeUserSettingsPath(), 'utf8')
      const p = await saveProfile(ctx, { name: 'Kimi', providerId: 'moonshot', apiKey: 'sk-moon', models: { main: 'kimi-k3[1m]' } })
      const res = await applyProfile(ctx, fakeProxy(), { profileId: p.id, targets: ['claude-code'] })
      expect(res.ok).toBe(false)
      expect(res.results[0].message).toMatch(/back up.*disk full/)
      expect(await readFile(claudeUserSettingsPath(), 'utf8')).toBe(before)
    })
  })

  it('uses apiKeyHelper instead of a plain key in key-helper mode', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      await seedFiles()
      const p = await saveProfile(ctx, { name: 'GLM', providerId: 'zai', apiKey: 'zai-key', useKeyHelper: true, models: { main: 'glm-5.3[1m]' } })
      const res = await applyProfile(ctx, fakeProxy(), { profileId: p.id, targets: ['claude-code', 'vscode'] })
      expect(res.ok).toBe(true)
      const s = await readJsonFile<Settings>(claudeUserSettingsPath())
      expect(s.apiKeyHelper).toBe(`"${keyHelperShimPath()}" secret get profile:${p.id}`)
      expect(res.warnings.some((w) => /terminal command is not installed/.test(w))).toBe(true)
      expect('ANTHROPIC_AUTH_TOKEN' in s.env!).toBe(false)
      expect(JSON.stringify(s)).not.toContain('zai-key')
      expect((await readVs()).env.some((e) => e.name === 'ANTHROPIC_AUTH_TOKEN')).toBe(false)
      expect(res.warnings.some((w) => /claude-setup command/.test(w))).toBe(true)
      await resetModels(ctx, ['claude-code'])
      expect('apiKeyHelper' in (await readJsonFile<Settings>(claudeUserSettingsPath()))).toBe(false)
    })
  })

  it('blanks ANTHROPIC_API_KEY for OpenRouter and uses x-api-key for Kimi Code', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const or = await saveProfile(ctx, { name: 'OR', providerId: 'openrouter', apiKey: 'sk-or', models: { main: 'z-ai/glm-5.3[1m]' } })
      await applyProfile(ctx, fakeProxy(), { profileId: or.id, targets: ['claude-code'] })
      let env = (await readJsonFile<Settings>(claudeUserSettingsPath())).env!
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-or')
      expect(env.ANTHROPIC_API_KEY).toBe('')
      expect(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY).toBe('1')

      const kcKey = 'sk-kimi-kc-key-0123456789-abcdefghijklmnop'
      const kc = await saveProfile(ctx, { name: 'KC', providerId: 'kimi-code', apiKey: kcKey, models: { main: 'k3.1-pro' } })
      const res = await applyProfile(ctx, fakeProxy(), { profileId: kc.id, targets: ['claude-code'] })
      env = (await readJsonFile<Settings>(claudeUserSettingsPath())).env!
      expect(env.ANTHROPIC_API_KEY).toBe(kcKey)
      expect('ANTHROPIC_AUTH_TOKEN' in env).toBe(false)
      expect('CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY' in env).toBe(false)
      expect(env.ANTHROPIC_BASE_URL).toBe('https://api.kimi.ai/coding/')
      expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('262144')
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('262144')
      // Claude Code would stop at "Do you want to use this API key?" (default answer: No) — approved for the user.
      const cj = await readJsonFile<{ customApiKeyResponses?: { approved: string[]; rejected: string[] } }>(claudeJsonPath())
      expect(cj.customApiKeyResponses).toEqual({ approved: [kcKey.slice(-20)], rejected: [] })
      expect(res.warnings.some((w) => /choose "Yes"/i.test(w))).toBe(false)
    })
  })

  it('approves an API key Claude Code was told to reject, for VS Code too, and backs up ~/.claude.json only on change', async () => {
    await withSandbox(async (sb) => {
      const { ctx, backups } = await makeContext(sb)
      const key = 'sk-kimi-REJECTEDBEFORE-0123456789abcdefghij'
      const tag = key.slice(-20)
      await writeText(vsPath(), '{}\n')
      await writeText(
        claudeJsonPath(),
        JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { fs: { type: 'stdio', command: 'npx' } }, customApiKeyResponses: { approved: ['someone-elses-key-01'], rejected: [tag] } })
      )
      const p = await saveProfile(ctx, { name: 'KC', providerId: 'kimi-code', apiKey: key, models: { main: 'k3.1-pro[1m]' } })
      const res = await applyProfile(ctx, fakeProxy(), { profileId: p.id, targets: ['vscode'] })
      expect(res.ok).toBe(true)
      const cj = await readJsonFile(claudeJsonPath())
      expect(cj.customApiKeyResponses).toEqual({ approved: ['someone-elses-key-01', tag], rejected: [] })
      expect(cj.mcpServers).toEqual({ fs: { type: 'stdio', command: 'npx' } })
      expect(res.warnings.some((w) => /choose "Yes"/i.test(w))).toBe(false)
      const jsonBackups = () => backups.snapshots.filter((s) => s.paths.includes(claudeJsonPath())).length
      expect(jsonBackups()).toBe(1)

      await applyProfile(ctx, fakeProxy(), { profileId: p.id, targets: ['vscode'] })
      expect(jsonBackups()).toBe(1)
      expect(await readFile(join(sb.dataDir, 'state.json'), 'utf8')).not.toContain(tag)
    })
  })

  it('cancels a conflicting credential exported in the shell', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      process.env.ANTHROPIC_API_KEY = 'shell-key'
      const p = await saveProfile(ctx, { name: 'DS', providerId: 'deepseek', apiKey: 'ds-key', models: { main: 'deepseek-flash[1m]' } })
      await applyProfile(ctx, fakeProxy(), { profileId: p.id, targets: ['claude-code'] })
      const env = (await readJsonFile<Settings>(claudeUserSettingsPath())).env!
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('ds-key')
      expect(env.ANTHROPIC_API_KEY).toBe('')
    })
  })

  it('switching providers removes the previous provider settings', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const zai = await saveProfile(ctx, { name: 'GLM', providerId: 'zai', apiKey: 'k', compatMode: false, models: { main: 'glm-5.3[1m]' } })
      await applyProfile(ctx, fakeProxy(), { profileId: zai.id, targets: ['claude-code'] })
      expect((await readJsonFile<Settings>(claudeUserSettingsPath())).env!.API_TIMEOUT_MS).toBe('3000000')
      const kimi = await saveProfile(ctx, { name: 'Kimi', providerId: 'moonshot', apiKey: 'k2', compatMode: false, models: { main: 'kimi-k3[1m]' } })
      await applyProfile(ctx, fakeProxy(), { profileId: kimi.id, targets: ['claude-code'] })
      const s = await readJsonFile<Settings>(claudeUserSettingsPath())
      expect('API_TIMEOUT_MS' in s.env!).toBe(false)
      expect(s.env!.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('kimi-k3[1m]')
      expect('skipWebFetchPreflight' in s).toBe(false)
    })
  })

  it('tracks cloud variables and removes them only while they hold the value Claude Setup wrote', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const missing = await saveProfile(ctx, { name: 'Vertex', providerId: 'vertex', models: { main: 'claude-opus-5-5' } })
      const fail = await applyProfile(ctx, fakeProxy(), { profileId: missing.id, targets: ['claude-code'] })
      expect(fail.ok).toBe(false)
      expect(fail.results[0].message).toMatch(/ANTHROPIC_VERTEX_PROJECT_ID/)

      const p = await saveProfile(ctx, { id: missing.id, name: 'Vertex', providerId: 'vertex', models: { main: 'claude-opus-5-5' }, extraEnv: { ANTHROPIC_VERTEX_PROJECT_ID: 'my-proj' } })
      const res = await applyProfile(ctx, fakeProxy(), { profileId: p.id, targets: ['claude-code'] })
      expect(res.ok).toBe(true)
      expect(res.warnings).not.toContain(ANTHROPIC_CAVEAT)
      const s = await readJsonFile<Settings>(claudeUserSettingsPath())
      expect(s.env!.CLAUDE_CODE_USE_VERTEX).toBe('1')
      expect(s.env!.CLOUD_ML_REGION).toBe('global')
      expect(s.env!.ANTHROPIC_VERTEX_PROJECT_ID).toBe('my-proj')
      expect('ANTHROPIC_BASE_URL' in s.env!).toBe(false)
      expect(s.env!.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-5-5')

      // The user changes the region by hand: it's theirs now.
      s.env!.CLOUD_ML_REGION = 'us-east5'
      await writeText(claudeUserSettingsPath(), JSON.stringify(s, null, 2))
      await resetModels(ctx, ['claude-code'])
      const after = await readJsonFile<Settings>(claudeUserSettingsPath())
      expect(after.env).toEqual({ CLOUD_ML_REGION: 'us-east5' })
    })
  })

  it('sets up the translation proxy for OpenAI-only providers', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const proxy = fakeProxy()
      const p = await saveProfile(ctx, { name: 'GPT', providerId: 'openai', apiKey: 'sk-openai', models: { main: 'gpt-6.1-sol[1m]' } })
      const res = await applyProfile(ctx, proxy, { profileId: p.id, targets: ['claude-code'] })
      expect(res.ok).toBe(true)
      expect(res.proxyStarted).toBe(true)
      expect(proxy.starts).toBe(1)

      const saved = proxy.saved.at(-1)!
      const upstream = saved.upstreams.find((u) => u.id === p.id)!
      expect(upstream.keyRef).toBe(`profile:${p.id}`)
      expect(upstream.baseUrl).toBe('https://api.openai.com/v1')
      expect(upstream.models.sort()).toEqual(['gpt-6-astra', 'gpt-6-luna', 'gpt-6.1-sol'])
      expect(upstream.useMaxCompletionTokens).toBe(true)
      expect(saved.routes['gpt-6.1-sol']).toBe(`${p.id}/gpt-6.1-sol`)
      expect(saved.routes['gpt-6-luna']).toBe(`${p.id}/gpt-6-luna`)
      expect(saved.defaultRoute).toBe(`${p.id}/gpt-6.1-sol`)
      expect(saved.smallRoute).toBe(`${p.id}/gpt-6-luna`)
      expect(saved.autoStart).toBe(true)

      const s = await readJsonFile<Settings>(claudeUserSettingsPath())
      expect(s.env!.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:3460')
      expect(s.env!.ANTHROPIC_AUTH_TOKEN).toBe('cs-test-proxy-token-0001')
      expect(s.env!.ENABLE_TOOL_SEARCH).toBe('false')
      expect(JSON.stringify(s)).not.toContain('sk-openai')
      expect(res.warnings.some((w) => /keep Claude Setup running/i.test(w))).toBe(true)
    })
  })

  it("replaces a profile's old proxy routes and keeps other upstreams", async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const proxy = fakeProxy()
      const base = await proxy.getConfig()
      await proxy.saveConfig({ ...base, upstreams: [{ id: 'manual', name: 'Manual', baseUrl: 'https://x.example/v1', models: ['m'] }], routes: { m: 'manual/m' } })
      const p = await saveProfile(ctx, { name: 'GPT', providerId: 'openai', apiKey: 'sk', models: { main: 'gpt-6.1-sol[1m]' } })
      await applyProfile(ctx, proxy, { profileId: p.id, targets: ['claude-code'] })
      await saveProfile(ctx, { id: p.id, name: 'GPT', providerId: 'openai', models: { main: 'gpt-6.1-sol[1m]', haiku: 'gpt-5.4-mini', fable: 'gpt-6.1-sol[1m]' } })
      await applyProfile(ctx, proxy, { profileId: p.id, targets: ['claude-code'] })
      const saved = proxy.saved.at(-1)!
      expect(saved.routes.m).toBe('manual/m')
      expect(saved.routes['gpt-5.4-mini']).toBe(`${p.id}/gpt-5.4-mini`)
      expect(saved.routes['gpt-6-luna']).toBeUndefined()
      expect(saved.routes['gpt-6-astra']).toBeUndefined()
      expect(saved.upstreams.map((u) => u.id)).toEqual(['manual', p.id])
      expect(saved.smallRoute).toBe(`${p.id}/gpt-5.4-mini`)
    })
  })

  it('reports a proxy that does not start, but keeps Claude Code configured', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const proxy = fakeProxy({ startResult: { running: false, lastError: 'Port 3460 is already used by another program.' } })
      const p = await saveProfile(ctx, { name: 'Groq', providerId: 'groq', apiKey: 'gsk', models: { main: 'openai/gpt-oss-120b' } })
      const res = await applyProfile(ctx, proxy, { profileId: p.id, targets: ['claude-code'] })
      expect(res.ok).toBe(false)
      expect(res.proxyStarted).toBe(false)
      expect(res.results[0].ok).toBe(true)
      expect(res.warnings.some((w) => /already used/.test(w))).toBe(true)
      const env = (await readJsonFile<Settings>(claudeUserSettingsPath())).env!
      expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('131072')
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('131072')
    })
  })

  it('writes nothing when the proxy cannot be configured', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const p = await saveProfile(ctx, { name: 'GPT', providerId: 'openai', apiKey: 'sk', models: { main: 'gpt-6.1-sol[1m]' } })
      const res = await applyProfile(ctx, fakeProxy({ failSave: 'bad config' }), { profileId: p.id, targets: ['claude-code', 'vscode'] })
      expect(res.ok).toBe(false)
      expect(res.results.every((r) => !r.ok && /bad config/.test(r.message))).toBe(true)
      await expect(readFile(claudeUserSettingsPath(), 'utf8')).rejects.toThrow()
    })
  })

  it('applying the Claude (Anthropic) preset without a key equals a reset', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const kimi = await saveProfile(ctx, { name: 'Kimi', providerId: 'moonshot', apiKey: 'k', models: { main: 'kimi-k3[1m]' } })
      await applyProfile(ctx, fakeProxy(), { profileId: kimi.id, targets: ['claude-code'] })
      const claude = await saveProfile(ctx, { name: 'Claude', providerId: 'anthropic', models: { main: 'claude-opus-5-5' } })
      const res = await applyProfile(ctx, fakeProxy(), { profileId: claude.id, targets: ['claude-code'] })
      expect(res.ok).toBe(true)
      expect(res.results[0].message).toMatch(/Claude account/)
      const s = await readJsonFile<Settings>(claudeUserSettingsPath())
      expect(s.env).toBeUndefined()
      expect(res.warnings).not.toContain(ANTHROPIC_CAVEAT)
    })
  })

  it("does not create VS Code settings when VS Code isn't set up", async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const p = await saveProfile(ctx, { name: 'Kimi', providerId: 'moonshot', apiKey: 'sk-moon', models: { main: 'kimi-k3[1m]' } })
      const res = await applyProfile(ctx, fakeProxy(), { profileId: p.id, targets: ['claude-code', 'vscode'] })
      expect(res.ok).toBe(false)
      expect(res.results.find((r) => r.target === 'claude-code')?.ok).toBe(true)
      expect(res.results.find((r) => r.target === 'vscode')?.message).toMatch(/Open VS Code once/)
      await expect(readFile(vsPath(), 'utf8')).rejects.toThrow()
      expect((await resetModels(ctx, ['vscode'])).ok).toBe(true)
    })
  })

  it('validates requests', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      expect((await applyProfile(ctx, fakeProxy(), { profileId: 'x', targets: [] })).warnings[0]).toMatch(/Choose/)
      expect((await applyProfile(ctx, fakeProxy(), { profileId: 'missing', targets: ['claude-code'] })).results[0].message).toMatch(/no longer exists/)
      const p = await saveProfile(ctx, { name: 'Kimi', providerId: 'moonshot', models: { main: 'kimi-k3[1m]' } })
      const noKey = await applyProfile(ctx, fakeProxy(), { profileId: p.id, targets: ['claude-code'] })
      expect(noKey.ok).toBe(false)
      expect(noKey.results[0].message).toMatch(/API key/)
      await mkdir(join(sb.home, '.claude'), { recursive: true })
    })
  })
})
