import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyProfile } from '@core/models/apply'
import { saveProfile } from '@core/models/profiles'
import { inspectModels, shellOverrideNames, toModelStatus } from '@core/models/status'
import { claudeUserSettingsPath, vscodeUserDir } from '@core/platform/paths'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { withSandbox } from '../helpers/sandbox'
import { cleanModelEnv, fakeProxy, makeContext, writeText } from './helpers'

let restoreEnv: () => void
beforeEach(() => {
  restoreEnv = cleanModelEnv()
})
afterEach(() => restoreEnv())

const settings = (env: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  writeText(claudeUserSettingsPath(), JSON.stringify({ env, ...extra }, null, 2))

const fullKimi = {
  ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic',
  ANTHROPIC_AUTH_TOKEN: 'k',
  ANTHROPIC_MODEL: 'kimi-k3[1m]',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k3[1m]',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k3[1m]',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k3[1m]',
  ANTHROPIC_DEFAULT_FABLE_MODEL: 'kimi-k3[1m]',
  CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-k3[1m]'
}

describe('status', () => {
  it('reports the official setup when nothing is configured', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const st = toModelStatus(await inspectModels(ctx, fakeProxy()))
      expect(st.mode).toBe('anthropic')
      expect(st.providerId).toBe('anthropic')
      expect(st.problems).toEqual([])
      expect(st.vscodeConfigured).toBe(false)
      expect(st.vscodeMatches).toBe(true)
      expect(st.shellOverrides).toEqual([])
    })
  })

  it('matches the applied profile and sees VS Code in sync', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      await mkdir(vscodeUserDir('Code'), { recursive: true })
      const p = await saveProfile(ctx, { name: 'Kimi', providerId: 'moonshot', apiKey: 'sk', models: { main: 'kimi-k3[1m]' } })
      const res = await applyProfile(ctx, fakeProxy(), { profileId: p.id, targets: ['claude-code', 'vscode'] })
      expect(res.ok).toBe(true)
      const st = toModelStatus(await inspectModels(ctx, fakeProxy()))
      expect(st.mode).toBe('custom')
      expect(st.profileId).toBe(p.id)
      expect(st.providerId).toBe('moonshot')
      expect(st.providerName).toBe('Kimi API (pay as you go)')
      expect(st.model).toBe('kimi-k3[1m]')
      expect(st.baseUrl).toBe('https://api.moonshot.ai/anthropic')
      expect(st.authVar).toBe('ANTHROPIC_AUTH_TOKEN')
      expect(st.vscodeConfigured).toBe(true)
      expect(st.vscodeMatches).toBe(true)
      expect(st.problems).toEqual([])
    })
  })

  it('recognises a hand-made setup and lists its problems', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      await settings({
        ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic/v1',
        ANTHROPIC_AUTH_TOKEN: 'k',
        ANTHROPIC_API_KEY: 'k2',
        ANTHROPIC_MODEL: 'kimi-k3[1m]',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-k2.7-code',
        ANTHROPIC_SMALL_FAST_MODEL: 'x',
        API_TIMEOUT_MS: 3000000
      })
      const i = await inspectModels(ctx, fakeProxy())
      const codes = i.issues.map((x) => x.code)
      expect(i.mode).toBe('custom')
      expect(i.preset?.id).toBe('moonshot')
      expect(codes).toEqual(expect.arrayContaining(['auth-conflict', 'missing-slots', 'retiring', 'base-url-v1', 'deprecated-var', 'non-string-env']))
      const st = toModelStatus(i)
      expect(st.problems.join(' ')).toMatch(/more than one credential/)
      expect(st.problems.join(' ')).toMatch(/ANTHROPIC_DEFAULT_OPUS_MODEL/)
      expect(st.problems.join(' ')).toMatch(/Kimi K2 series/)
    })
  })

  it('reports an unreadable settings file', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      await writeText(claudeUserSettingsPath(), '{ "env": { "A": "1", } }')
      const i = await inspectModels(ctx, fakeProxy())
      expect(i.settingsError).toBeTruthy()
      expect(i.issues[0].code).toBe('settings-invalid')
      expect(toModelStatus(i).problems[0]).toMatch(/Settings Error/)
    })
  })

  it('notices when the proxy Claude Code relies on is not running', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      await settings({ ...fullKimi, ANTHROPIC_BASE_URL: 'http://127.0.0.1:3460', ANTHROPIC_AUTH_TOKEN: 'cs-test-proxy-token-0001' })
      const proxy = fakeProxy()
      let i = await inspectModels(ctx, proxy)
      expect(i.usesProxy).toBe(true)
      expect(i.proxyRunning).toBe(false)
      expect(i.issues.map((x) => x.code)).toContain('proxy-down')
      expect(i.providerName).toMatch(/proxy/)
      proxy.setRunning(true)
      i = await inspectModels(ctx, proxy)
      expect(i.issues.map((x) => x.code)).not.toContain('proxy-down')
      await settings({ ...fullKimi, ANTHROPIC_BASE_URL: 'http://127.0.0.1:3460', ANTHROPIC_AUTH_TOKEN: 'old-token' })
      i = await inspectModels(ctx, proxy)
      expect(i.issues.map((x) => x.code)).toContain('proxy-token')
    })
  })

  it('lists shell overrides by name and flags routing that settings.json does not override', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com/anthropic'
      process.env.ANTHROPIC_AUTH_TOKEN = 'secret-shell-token'
      const i = await inspectModels(ctx, fakeProxy())
      expect(i.shellOverrides).toEqual(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'])
      expect(i.issues.find((x) => x.code === 'shell-routing')?.message).toMatch(/gateway\.example\.com/)
      expect(JSON.stringify(toModelStatus(i))).not.toContain('secret-shell-token')
      expect(shellOverrideNames({ anthropic_model: 'x', CLAUDE_CODE_USE_BEDROCK: '1', OTHER: 'y', ANTHROPIC_EMPTY: '' })).toEqual([
        'ANTHROPIC_MODEL',
        'CLAUDE_CODE_USE_BEDROCK'
      ])
    })
  })

  it('detects a VS Code configuration that differs from the terminal', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      await settings(fullKimi)
      await writeText(
        join(vscodeUserDir('Code'), 'settings.json'),
        JSON.stringify({ 'claudeCode.environmentVariables': [{ name: 'ANTHROPIC_BASE_URL', value: 'https://api.deepseek.com/anthropic' }] })
      )
      const st = toModelStatus(await inspectModels(ctx, fakeProxy()))
      expect(st.vscodeConfigured).toBe(true)
      expect(st.vscodeMatches).toBe(false)
    })
  })

  it('identifies official cloud providers', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      await settings({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' })
      const st = toModelStatus(await inspectModels(ctx, fakeProxy()))
      expect(st.mode).toBe('cloud')
      expect(st.providerId).toBe('bedrock')
      expect(st.problems).toEqual([])
    })
  })
})
