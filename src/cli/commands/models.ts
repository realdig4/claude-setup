/** `models providers|profiles|status|use|reset|test|add|remove`: third-party models for Claude Code. */
import type { Command } from 'commander'
import type { Core } from '@core/index'
import type { ApplyModelResult, ConnectionTestResult, ModelPreset, ModelProfile, ModelSlot, ModelStatus, ModelTarget, ProviderPreset } from '@shared/types'
import { THIRD_PARTY_CAVEAT } from '../../mcp/format'
import { defaultModelTargets } from '../../mcp/helpers'
import { collect, parseModelTargets } from '../args'
import type { CliContext } from '../context'
import { CliError, EXIT } from '../errors'
import { targetLabel, truncate } from '../format'
import { readAllStdin } from '../stdin'

function findProfile(profiles: ModelProfile[], idOrName: string): ModelProfile {
  const exact = profiles.find((p) => p.id === idOrName) ?? profiles.find((p) => p.name.toLowerCase() === idOrName.toLowerCase())
  if (exact) return exact
  const list = profiles.map((p) => `${p.id} (${p.name})`).join(', ')
  throw new CliError(`No model profile "${idOrName}".`, EXIT.failed, list ? `Profiles: ${list}` : 'Create one with: claude-setup models add')
}

function findProvider(providers: ProviderPreset[], idOrName: string): ProviderPreset {
  const lower = idOrName.toLowerCase()
  const match = providers.find((p) => p.id.toLowerCase() === lower) ?? providers.find((p) => p.name.toLowerCase() === lower)
  if (match) return match
  throw new CliError(`Unknown provider "${idOrName}".`, EXIT.usage, `See the list: claude-setup models providers`)
}

async function modelTargets(core: Core, values: string[]): Promise<ModelTarget[]> {
  return values.length ? parseModelTargets(values) : defaultModelTargets(core)
}

function printApply(ctx: CliContext, r: ApplyModelResult): void {
  const { out } = ctx
  for (const x of r.results) {
    const icon = x.ok ? out.c.green(out.sym.ok) : out.c.red(out.sym.fail)
    out.line(`${icon} ${out.c.bold(targetLabel(x.target))}: ${x.message}`)
    const details = [x.configPath ? `file: ${x.configPath}` : '', x.backupId ? `backup: ${x.backupId}` : ''].filter(Boolean).join(' · ')
    if (details) out.line(`  ${out.c.dim(details)}`)
  }
  if (r.proxyStarted) out.info('The local translation proxy was started for this provider.')
  for (const w of r.warnings) out.warn(w)
}

function printConnection(ctx: CliContext, r: ConnectionTestResult): void {
  const { out } = ctx
  const ms = `${r.ms} ms`
  if (r.ok) out.success(`${r.message} ${out.c.dim(`(${ms})`)}`)
  else out.error(`${r.message} ${out.c.dim(`(${r.verdict}${r.status ? `, HTTP ${r.status}` : ''}, ${ms})`)}`)
  if (r.sample) out.line(`  ${out.c.dim(`Reply: ${truncate(r.sample, 120)}`)}`)
}

function printStatus(ctx: CliContext, s: ModelStatus): void {
  const { out } = ctx
  if (s.mode === 'anthropic') out.line(`Claude Code uses ${out.c.bold('Claude')} (no third-party model configured).`)
  else if (s.mode === 'cloud') out.line(`Claude Code uses Claude through ${out.c.bold(s.providerName ?? 'a cloud provider')}.`)
  else out.line(`Claude Code uses ${out.c.bold(s.providerName ?? 'a custom provider')}${s.model ? ` ${out.sym.dash} ${s.model}` : ''}`)
  out.pairs([
    ['Endpoint', s.baseUrl],
    ['Profile', s.profileId],
    ['Key from', s.authVar],
    ['VS Code', s.vscodeConfigured ? (s.vscodeMatches ? 'configured' : out.c.yellow('configured, but different from Claude Code')) : 'not configured']
  ])
  for (const p of s.problems) out.warn(p)
  if (s.shellOverrides.length) out.warn(`These shell variables override your settings: ${s.shellOverrides.join(', ')}`)
}

/** Fill every model slot: chosen main/fast models, keeping preset slots that name a different model. */
export function slotModels(provider: ProviderPreset, main: string, fast: string): Partial<Record<ModelSlot, string>> & { main: string } {
  const slots: Partial<Record<ModelSlot, string>> & { main: string } = { main, haiku: fast }
  for (const slot of ['opus', 'sonnet', 'fable', 'subagent'] as const) {
    const preset = provider.defaults[slot]
    slots[slot] = preset && preset !== provider.defaults.main ? preset : main
  }
  return slots
}

async function chooseModel(ctx: CliContext, question: string, candidates: ModelPreset[], fallback: string): Promise<string> {
  if (!candidates.length) return ctx.prompt.text(question, { default: fallback, validate: (v) => (v ? undefined : 'A model id is required.') })
  const choices = candidates.map((m) => ({
    label: m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id,
    value: m.id,
    hint: [m.context ? `${Math.round(m.context / 1000)}k context` : '', m.notes ? truncate(m.notes, 50) : ''].filter(Boolean).join(', ')
  }))
  choices.push({ label: 'Other — type a model id', value: '\u0000other', hint: '' })
  const index = Math.max(0, candidates.findIndex((m) => m.id === fallback))
  const picked = await ctx.prompt.select(question, choices, index)
  if (picked !== '\u0000other') return picked
  return ctx.prompt.text('Model id:', { validate: (v) => (v ? undefined : 'A model id is required.') })
}

interface AddOptions {
  provider?: string
  region?: string
  baseUrl?: string
  keyStdin?: boolean
  model?: string
  fastModel?: string
  name?: string
  use?: boolean
  target: string[]
  test: boolean
  yes?: boolean
}

async function addProfile(ctx: CliContext, opts: AddOptions): Promise<void> {
  const core = await ctx.core()
  const ask = ctx.prompt.interactive && !opts.yes
  const providers = (await core.models.providers()).filter((p) => p.kind !== 'anthropic')
  if (!providers.length) throw new CliError('No model providers are available.')
  let provider: ProviderPreset
  if (opts.provider) provider = findProvider(providers, opts.provider)
  else if (ask) {
    provider = await ctx.prompt.select(
      'Which provider?',
      providers.map((p) => ({ label: p.name, value: p, hint: [p.vendor !== p.name ? p.vendor : '', ...p.tags.slice(0, 3)].filter(Boolean).join(', ') }))
    )
  } else throw new CliError('Choose a provider.', EXIT.usage, 'Add --provider <id> (see: claude-setup models providers).')

  let region = provider.regions[0]
  if (opts.region) {
    const found = provider.regions.find((r) => r.id === opts.region || r.label.toLowerCase() === opts.region?.toLowerCase())
    if (!found) throw new CliError(`${provider.name} has no region "${opts.region}".`, EXIT.usage, `Regions: ${provider.regions.map((r) => r.id).join(', ')}`)
    region = found
  } else if (provider.regions.length > 1 && ask) {
    region = await ctx.prompt.select('Which region / endpoint?', provider.regions.map((r) => ({ label: r.label, value: r, hint: r.baseUrl })))
  }

  let baseUrl = opts.baseUrl
  if (!baseUrl && (provider.kind === 'custom' || !region)) {
    if (!ask) throw new CliError(`${provider.name} needs an endpoint URL.`, EXIT.usage, 'Add --base-url <url>.')
    baseUrl = await ctx.prompt.text('Endpoint URL (Anthropic-compatible, without /v1):', {
      validate: (v) => (/^https?:\/\/\S+$/.test(v) ? undefined : 'Enter a URL starting with https:// or http://')
    })
  }

  let apiKey: string | undefined
  if (opts.keyStdin) {
    apiKey = (await readAllStdin(ctx.io.stdin)).trim()
    if (!apiKey && provider.requiresKey) throw new CliError('No API key was received on standard input.', EXIT.usage)
  } else if (provider.requiresKey) {
    if (!ask) throw new CliError(`${provider.name} needs an API key.`, EXIT.usage, 'Pipe it in with --key-stdin, e.g.: echo $KEY | claude-setup models add --provider … --key-stdin')
    if (provider.keyUrl) ctx.out.line(`  ${ctx.out.c.dim(`Get a key at ${provider.keyUrl}`)}`)
    apiKey = await ctx.prompt.secret(`${provider.name} API key:`)
  } else if (provider.defaultKey) {
    apiKey = provider.defaultKey
  }

  let candidates = provider.models
  if (ask && !opts.model && provider.listModels) {
    const live = await ctx.out
      .withSpinner('Fetching the model list…', () => core.models.listModels({ providerId: provider.id, regionId: region?.id, baseUrl, apiKey }))
      .catch(() => [] as ModelPreset[])
    if (live.length) candidates = [...provider.models, ...live.filter((m) => !provider.models.some((p) => p.id === m.id))]
  }
  const main = opts.model ?? (ask ? await chooseModel(ctx, 'Main model:', candidates, provider.defaults.main) : provider.defaults.main)
  const fastDefault = provider.defaults.haiku ?? main
  const fast = opts.fastModel ?? (ask && candidates.length > 1 ? await chooseModel(ctx, 'Fast model (quick background tasks):', candidates, fastDefault) : fastDefault)
  const name = opts.name ?? (ask ? await ctx.prompt.text('Profile name:', { default: provider.name }) : provider.name)

  if (opts.test) {
    const result = await ctx.out.withSpinner('Testing the connection…', () =>
      core.models.testConnection({ providerId: provider.id, regionId: region?.id, baseUrl, apiKey, model: main })
    )
    if (!ctx.json) printConnection(ctx, result)
    if (!result.ok) {
      const keep = ask ? await ctx.prompt.confirm('The test failed. Save the profile anyway?', false) : !!opts.yes
      if (!keep) {
        ctx.fail()
        if (!ctx.json) ctx.out.line('The profile was not saved.')
        else ctx.out.printJson({ saved: false, test: result })
        return
      }
    }
  }

  const profile = await core.models.saveProfile({ name, providerId: provider.id, regionId: region?.id, baseUrl, apiKey, models: slotModels(provider, main, fast) })
  if (!ctx.json) ctx.out.success(`Saved profile "${profile.name}" (id: ${profile.id}).`)
  const use = opts.use ?? (ask ? await ctx.prompt.confirm('Use it in Claude Code now?', true) : false)
  let applied: ApplyModelResult | undefined
  if (use) {
    applied = await ctx.out.withSpinner('Applying…', async () => core.models.apply({ profileId: profile.id, targets: await modelTargets(core, opts.target) }))
    if (!applied.ok) ctx.fail()
    if (!ctx.json) {
      printApply(ctx, applied)
      ctx.out.hint('Start a new Claude Code session to use it.')
      ctx.out.warn(THIRD_PARTY_CAVEAT)
    }
  } else if (!ctx.json) {
    ctx.out.hint(`Use it later with: claude-setup models use ${profile.id}`)
  }
  if (ctx.json) ctx.out.printJson({ saved: true, profile, applied })
}

/** Register `models providers|profiles|status|use|reset|test|add|remove`. */
export function registerModelCommands(program: Command, ctx: CliContext): void {
  const models = program.command('models').alias('model').description('Use other models (Kimi, DeepSeek, GLM, Qwen, OpenRouter, Ollama…) in Claude Code')

  models
    .command('providers')
    .description('List supported model providers')
    .action(async () => {
      const core = await ctx.core()
      const providers = await core.models.providers()
      if (ctx.json) return ctx.out.printJson(providers)
      const { out } = ctx
      out.table(
        ['ID', 'PROVIDER', 'KEY', 'DEFAULT MODEL', 'TAGS'],
        providers.map((p) => [p.id, p.name, p.requiresKey ? 'needed' : out.c.dim('none'), p.defaults.main, out.c.dim(p.tags.join(', '))])
      )
      out.hint('Create a profile: claude-setup models add')
    })

  models
    .command('profiles')
    .description('List saved model profiles')
    .action(async () => {
      const core = await ctx.core()
      const [profiles, status] = await Promise.all([core.models.profiles(), core.models.status().catch(() => null)])
      if (ctx.json) return ctx.out.printJson(profiles)
      const { out } = ctx
      if (!profiles.length) {
        out.line('No model profiles yet.')
        out.hint('Create one: claude-setup models add')
        return
      }
      out.table(
        ['', 'ID', 'NAME', 'PROVIDER', 'MODEL', 'KEY'],
        profiles.map((p) => [
          status?.mode === 'custom' && status.profileId === p.id ? out.c.green(out.sym.ok) : ' ',
          p.id,
          p.name,
          p.providerId,
          p.models.main,
          p.hasKey ? 'stored' : out.c.yellow('missing')
        ]),
        { flex: 2 }
      )
    })

  models
    .command('status')
    .description('Show which model Claude Code uses right now')
    .action(async () => {
      const core = await ctx.core()
      const s = await core.models.status()
      if (s.problems.length) ctx.fail()
      if (ctx.json) return ctx.out.printJson(s)
      printStatus(ctx, s)
    })

  models
    .command('use')
    .description('Make Claude Code (and VS Code) use a saved profile')
    .argument('<profile>', 'Profile id or name')
    .option('-t, --target <targets>', 'code and/or vscode (default: Claude Code, plus VS Code when installed)', collect, [])
    .action(async (idOrName: string, opts: { target: string[] }) => {
      const core = await ctx.core()
      const profile = findProfile(await core.models.profiles(), idOrName)
      const targets = await modelTargets(core, opts.target)
      const r = await ctx.out.withSpinner(`Switching to ${profile.name}…`, () => core.models.apply({ profileId: profile.id, targets }))
      if (!r.ok) ctx.fail()
      if (ctx.json) return ctx.out.printJson(r)
      printApply(ctx, r)
      if (r.ok) ctx.out.hint('Start a new Claude Code session to use it.')
      ctx.out.warn(THIRD_PARTY_CAVEAT)
    })

  models
    .command('reset')
    .description('Remove third-party model settings so Claude Code uses Claude again')
    .option('-t, --target <targets>', 'code and/or vscode (default: both)', collect, [])
    .action(async (opts: { target: string[] }) => {
      const core = await ctx.core()
      const targets = opts.target.length ? parseModelTargets(opts.target) : (['claude-code', 'vscode'] as ModelTarget[])
      const r = await ctx.out.withSpinner('Resetting…', () => core.models.reset(targets))
      if (!r.ok) ctx.fail()
      if (ctx.json) return ctx.out.printJson(r)
      printApply(ctx, r)
      if (r.ok) ctx.out.hint('Start a new Claude Code session to use Claude again.')
    })

  models
    .command('test')
    .description('Send a tiny request to check a profile works')
    .argument('<profile>', 'Profile id or name')
    .action(async (idOrName: string) => {
      const core = await ctx.core()
      const profile = findProfile(await core.models.profiles(), idOrName)
      const r = await ctx.out.withSpinner(`Testing ${profile.name}…`, () => core.models.testConnection({ profileId: profile.id }))
      if (!r.ok) ctx.fail()
      if (ctx.json) return ctx.out.printJson(r)
      printConnection(ctx, r)
    })

  models
    .command('add')
    .description('Create a model profile step by step (provider, region, key, models)')
    .option('--provider <id>', 'Provider id (see "models providers")')
    .option('--region <id>', 'Region or endpoint id')
    .option('--base-url <url>', 'Custom endpoint URL')
    .option('--key-stdin', 'Read the API key from standard input instead of asking')
    .option('-m, --model <id>', 'Main model id')
    .option('--fast-model <id>', 'Model for quick background tasks')
    .option('-n, --name <name>', 'Profile name')
    .option('--use', 'Apply the profile right away')
    .option('-t, --target <targets>', 'With --use: code and/or vscode', collect, [])
    .option('--no-test', 'Skip the connection test')
    .option('-y, --yes', 'Do not ask questions (use defaults)')
    .action(async (opts: AddOptions) => addProfile(ctx, opts))

  models
    .command('remove')
    .alias('delete')
    .description('Delete a saved model profile (and its stored key)')
    .argument('<profile>', 'Profile id or name')
    .option('-y, --yes', 'Do not ask for confirmation')
    .action(async (idOrName: string, opts: { yes?: boolean }) => {
      const core = await ctx.core()
      const profile = findProfile(await core.models.profiles(), idOrName)
      if (!(await ctx.confirmOrYes(`Delete the profile "${profile.name}"?`, opts.yes, false))) return ctx.out.line('Nothing was changed.')
      const r = await core.models.deleteProfile(profile.id)
      if (!r.ok) ctx.fail()
      if (ctx.json) return ctx.out.printJson(r)
      if (r.ok) ctx.out.success(r.message)
      else ctx.out.error(r.message)
    })
}
