/** MCP tools: third-party model providers and profiles for Claude Code. */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ApplyModelResult, ModelStatus } from '@shared/types'
import { defaultModelTargets, defineTool, modelTargetSchema, type CoreGetter } from './common'
import { THIRD_PARTY_CAVEAT, UserError, targetLabel, toolResult } from './format'

function statusText(s: ModelStatus): string {
  const lines: string[] = []
  if (s.mode === 'anthropic') lines.push('Claude Code uses Claude (Anthropic) — no third-party model is configured.')
  else if (s.mode === 'cloud') lines.push(`Claude Code uses Claude through a cloud provider${s.providerName ? ` (${s.providerName})` : ''}.`)
  else {
    lines.push(`Claude Code uses ${s.providerName ?? 'a custom provider'}${s.model ? ` with model ${s.model}` : ''}.`)
    if (s.baseUrl) lines.push(`Endpoint: ${s.baseUrl}`)
    if (s.profileId) lines.push(`Profile: ${s.profileId}`)
    if (s.authVar) lines.push(`Key from: ${s.authVar}`)
  }
  lines.push(s.vscodeConfigured ? `VS Code: configured${s.vscodeMatches ? '' : ' (differs from Claude Code — switch the profile again to sync)'}` : 'VS Code: not configured')
  for (const p of s.problems) lines.push(`Problem: ${p}`)
  if (s.shellOverrides.length) lines.push(`Shell variables that override settings: ${s.shellOverrides.join(', ')}`)
  return lines.join('\n')
}

function applyText(r: ApplyModelResult, intro: string): string {
  const lines = [intro]
  for (const x of r.results) lines.push(`${x.ok ? '✔' : '✘'} ${targetLabel(x.target)}: ${x.message}${x.backupId ? ` (backup: ${x.backupId})` : ''}`)
  if (r.proxyStarted) lines.push('The local translation proxy was started for this provider.')
  for (const w of r.warnings) lines.push(`Note: ${w}`)
  return lines.join('\n')
}

/** Register the model provider/profile tools. */
export function registerModelTools(server: McpServer, getCore: CoreGetter): void {
  defineTool(
    server,
    'list_model_providers',
    {
      title: 'List model providers',
      description: 'Providers whose models Claude Code can use (Kimi, DeepSeek, GLM, Qwen, OpenRouter, Ollama, …) with their default models.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => {
      const core = await getCore()
      const providers = await core.models.providers()
      const lines = providers.map(
        (p) =>
          `• ${p.name} (id: ${p.id}) — ${p.kind}${p.requiresKey ? ', needs API key' : ''}; default model ${p.defaults.main}` +
          (p.tags.length ? ` [${p.tags.join(', ')}]` : '')
      )
      return toolResult(lines.join('\n') || 'No providers available.', {
        providers: providers.map((p) => ({
          id: p.id,
          name: p.name,
          vendor: p.vendor,
          kind: p.kind,
          requiresKey: p.requiresKey,
          regions: p.regions.map((r) => r.id),
          defaults: p.defaults,
          models: p.models.slice(0, 12).map((m) => m.id),
          tags: p.tags,
          ...(p.keyUrl ? { keyUrl: p.keyUrl } : {})
        }))
      })
    }
  )

  defineTool(
    server,
    'list_model_profiles',
    {
      title: 'List model profiles',
      description: 'Saved model profiles (provider + models + stored key) that switch_model_profile can apply.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => {
      const core = await getCore()
      const [profiles, status] = await Promise.all([core.models.profiles(), core.models.status().catch(() => null)])
      if (!profiles.length) {
        return toolResult('No model profiles yet. Create one in the Claude Setup app (Models) or with "claude-setup models add".', { profiles: [] })
      }
      const lines = profiles.map(
        (p) =>
          `• ${p.name} (id: ${p.id}) — provider ${p.providerId}, model ${p.models.main}${p.hasKey ? '' : ', no key stored'}` +
          (status?.profileId === p.id && status.mode === 'custom' ? ' — active' : '')
      )
      return toolResult(lines.join('\n'), {
        activeProfileId: status?.mode === 'custom' ? status.profileId : undefined,
        profiles: profiles.map((p) => ({ id: p.id, name: p.name, providerId: p.providerId, baseUrl: p.baseUrl, hasKey: p.hasKey, models: p.models }))
      })
    }
  )

  defineTool(
    server,
    'get_model_status',
    {
      title: 'Get model status',
      description: 'Which model Claude Code (and the VS Code extension) currently uses, plus configuration problems such as conflicting keys.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => {
      const core = await getCore()
      const s = await core.models.status()
      return toolResult(statusText(s), { ...s })
    }
  )

  defineTool(
    server,
    'switch_model_profile',
    {
      title: 'Switch model profile',
      description: 'Make Claude Code (and the VS Code extension) use a saved model profile. Confirm with the user first. Takes effect in new Claude Code sessions.',
      inputSchema: z.object({
        profile_id: z.string().min(1).max(200).describe('Profile id from list_model_profiles'),
        targets: z.array(modelTargetSchema).min(1).optional().describe('Default: Claude Code, plus VS Code when installed')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (a) => {
      const core = await getCore()
      const profiles = await core.models.profiles()
      const profile = profiles.find((p) => p.id === a.profile_id)
      if (!profile) {
        const ids = profiles.map((p) => p.id).join(', ')
        throw new UserError(`No model profile with id "${a.profile_id}".${ids ? ` Available: ${ids}.` : ' Create one in the Claude Setup app first.'}`)
      }
      const targets = a.targets ?? (await defaultModelTargets(core))
      const r = await core.models.apply({ profileId: profile.id, targets })
      const text = applyText(r, r.ok ? `Claude Code now uses "${profile.name}". Start a new Claude Code session to use it.` : `Could not fully switch to "${profile.name}".`)
      return toolResult(`${text}\n${THIRD_PARTY_CAVEAT}`, { ...r }, !r.ok)
    }
  )

  defineTool(
    server,
    'reset_model_to_claude',
    {
      title: 'Reset model to Claude',
      description: 'Remove all third-party model settings so Claude Code (and the VS Code extension) use Claude again. Confirm with the user first.',
      inputSchema: z.object({
        targets: z.array(modelTargetSchema).min(1).optional().describe('Default: Claude Code and VS Code')
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async (a) => {
      const core = await getCore()
      const r = await core.models.reset(a.targets ?? ['claude-code', 'vscode'])
      return toolResult(applyText(r, r.ok ? 'Claude Code is back on Claude. Start a new session to apply it.' : 'The reset did not fully succeed.'), { ...r }, !r.ok)
    }
  )
}

