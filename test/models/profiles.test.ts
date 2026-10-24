import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deleteProfile, listProfiles, saveProfile } from '@core/models/profiles'
import { withSandbox } from '../helpers/sandbox'
import { makeContext } from './helpers'

describe('model profiles', () => {
  it('creates a profile and keeps the API key only in the secret store', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const p = await saveProfile(ctx, { name: 'My Kimi', providerId: 'moonshot', apiKey: '  "Bearer sk-secret-123"  ', models: { main: 'kimi-k3[1m]' } })
      expect(p.id).toMatch(/^my-kimi-[0-9a-f]{6}$/)
      expect(p.keyRef).toBe(`profile:${p.id}`)
      expect(p.hasKey).toBe(true)
      expect(await ctx.secrets.get(p.keyRef!)).toBe('sk-secret-123')
      expect(p.baseUrl).toBe('https://api.moonshot.ai/anthropic')
      expect(p.regionId).toBe('global')
      expect(p.models).toEqual({
        main: 'kimi-k3[1m]',
        opus: 'kimi-k3[1m]',
        sonnet: 'kimi-k3[1m]',
        haiku: 'kimi-k3[1m]',
        fable: 'kimi-k3[1m]',
        subagent: 'kimi-k3[1m]'
      })
      expect(p.compatMode).toBe(true)
      expect(p.contextWindow).toBe(1_000_000)
      expect(p.createdAt).toBe(p.updatedAt)

      const stateText = await readFile(join(sb.dataDir, 'state.json'), 'utf8')
      expect(stateText).not.toContain('sk-secret-123')
      expect(JSON.parse(stateText).profiles).toHaveLength(1)
    })
  })

  it('uses the chosen region and cleans custom addresses', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const china = await saveProfile(ctx, { name: 'Kimi CN', providerId: 'moonshot', regionId: 'china', apiKey: 'k', models: { main: 'kimi-k3[1m]' } })
      expect(china.baseUrl).toBe('https://api.moonshot.cn/anthropic')
      const custom = await saveProfile(ctx, { name: 'Gateway', providerId: 'custom', baseUrl: 'https://gw.example.com/anthropic/v1/', models: { main: 'my-model' } })
      expect(custom.baseUrl).toBe('https://gw.example.com/anthropic')
      expect(custom.hasKey).toBe(false)
      expect(custom.keyRef).toBeUndefined()
      expect(custom.models.haiku).toBe('my-model')
      const oai = await saveProfile(ctx, { name: 'vLLM', providerId: 'openai-compatible', baseUrl: 'http://localhost:8000/v1/', models: { main: 'qwen' } })
      expect(oai.baseUrl).toBe('http://localhost:8000/v1')
      expect(oai.compatMode).toBe(true)
    })
  })

  it('fills missing slots from the preset when the default model is used, else from the main model', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const ds = await saveProfile(ctx, { name: 'DS', providerId: 'deepseek', apiKey: 'k', models: { main: 'deepseek-flash[1m]' } })
      expect(ds.models.haiku).toBe('deepseek-flash')
      expect(ds.models.subagent).toBe('deepseek-flash')
      expect(ds.contextWindow).toBe(786432)
      const pro = await saveProfile(ctx, { name: 'DS Pro', providerId: 'deepseek', apiKey: 'k', models: { main: 'deepseek-v4-pro[1m]', haiku: 'deepseek-flash' } })
      expect(pro.models.opus).toBe('deepseek-v4-pro[1m]')
      expect(pro.models.haiku).toBe('deepseek-flash')
      expect(pro.contextWindow).toBeUndefined()
    })
  })

  it('updates in place, keeps the key, and drops it when the provider changes', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const p = await saveProfile(ctx, { name: 'A', providerId: 'zai', apiKey: 'zai-key', models: { main: 'glm-5.3[1m]' } })
      await new Promise((r) => setTimeout(r, 5))
      const renamed = await saveProfile(ctx, { id: p.id, name: 'B', providerId: 'zai', models: { main: 'glm-5.3[1m]' } })
      expect(renamed.id).toBe(p.id)
      expect(renamed.name).toBe('B')
      expect(renamed.createdAt).toBe(p.createdAt)
      expect(renamed.updatedAt >= p.updatedAt).toBe(true)
      expect(renamed.hasKey).toBe(true)
      expect(await ctx.secrets.get(`profile:${p.id}`)).toBe('zai-key')
      expect(ctx.state.get().profiles).toHaveLength(1)

      const moved = await saveProfile(ctx, { id: p.id, name: 'B', providerId: 'minimax', models: { main: 'MiniMax-M3.1-Flash[1m]' } })
      expect(moved.hasKey).toBe(false)
      expect(await ctx.secrets.has(`profile:${p.id}`)).toBe(false)
    })
  })

  it('rejects invalid input with friendly messages', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      await expect(saveProfile(ctx, { name: ' ', providerId: 'moonshot', models: { main: 'x' } })).rejects.toThrow(/name/)
      await expect(saveProfile(ctx, { name: 'x', providerId: 'nope', models: { main: 'x' } })).rejects.toThrow(/Unknown provider/)
      await expect(saveProfile(ctx, { name: 'x', providerId: 'custom', models: { main: 'x' } })).rejects.toThrow(/address/)
      await expect(saveProfile(ctx, { name: 'x', providerId: 'custom', baseUrl: 'ftp://x', models: { main: 'x' } })).rejects.toThrow(/http/)
      await expect(saveProfile(ctx, { name: 'x', providerId: 'moonshot', models: { main: '' } })).rejects.toThrow(/model/)
      await expect(saveProfile(ctx, { name: 'x', providerId: 'moonshot', models: { main: 'bad id' } })).rejects.toThrow(/not a valid model/)
      await expect(
        saveProfile(ctx, { name: 'x', providerId: 'moonshot', models: { main: 'kimi-k3[1m]' }, extraEnv: { ANTHROPIC_AUTH_TOKEN: 'x' } })
      ).rejects.toThrow(/can't be set/)
      await expect(saveProfile(ctx, { name: 'x', providerId: 'moonshot', models: { main: 'kimi-k3[1m]' }, extraEnv: { 'BAD NAME': '1' } })).rejects.toThrow(
        /not a valid environment variable/
      )
      await expect(saveProfile(ctx, { name: 'x', providerId: 'moonshot', apiKey: 'two words', models: { main: 'kimi-k3[1m]' } })).rejects.toThrow(/spaces/)
      await expect(saveProfile(ctx, { name: 'x', providerId: 'moonshot', models: { main: 'kimi-k3[1m]' }, contextWindow: 5 })).rejects.toThrow(/context window/)
      expect(ctx.state.get().profiles).toHaveLength(0)
    })
  })

  it('deletes a profile with its key and explains when it was active', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const a = await saveProfile(ctx, { name: 'A', providerId: 'moonshot', apiKey: 'k1', models: { main: 'kimi-k3[1m]' } })
      const b = await saveProfile(ctx, { name: 'B', providerId: 'deepseek', apiKey: 'k2', models: { main: 'deepseek-flash[1m]' } })
      await ctx.state.update((d) => {
        d.activeProfileId = b.id
      })
      const r1 = await deleteProfile(ctx, a.id)
      expect(r1.ok).toBe(true)
      expect(await ctx.secrets.has(`profile:${a.id}`)).toBe(false)
      const r2 = await deleteProfile(ctx, b.id)
      expect(r2.ok).toBe(true)
      expect(r2.message).toMatch(/still set up/)
      expect(ctx.state.get().activeProfileId).toBeUndefined()
      expect(ctx.state.get().profiles).toHaveLength(0)
      expect((await deleteProfile(ctx, 'missing')).ok).toBe(false)
    })
  })

  it('refreshes hasKey from the secret store when listing', async () => {
    await withSandbox(async (sb) => {
      const { ctx } = await makeContext(sb)
      const p = await saveProfile(ctx, { name: 'A', providerId: 'moonshot', apiKey: 'k1', models: { main: 'kimi-k3[1m]' } })
      await ctx.secrets.delete(p.keyRef!)
      const [listed] = await listProfiles(ctx)
      expect(listed.hasKey).toBe(false)
    })
  })
})
