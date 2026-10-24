/**
 * Mock: ModelsApi — provider presets (Anthropic, Kimi, DeepSeek, GLM, OpenRouter, Groq via proxy, Ollama),
 * saved profiles, the current Claude Code model status, apply/reset and connection tests.
 * Values follow research_providers.md (verified 2026-10-23).
 */
import type { ModelsApi } from '@shared/api'
import type { ApplyModelResult, ConnectionTestResult, ModelPreset, ModelProfile, ModelStatus, ModelTarget, OpResult, ProviderPreset } from '@shared/types'
import { recordBackup, secretExists, storeSecret } from './misc'
import { claudeSettingsPath, vscodeSettingsPath } from './paths'
import { startProxy } from './proxy'
import { clone, daysAgo, log, sleep, uid } from './runtime'

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'anthropic',
    name: 'Claude',
    vendor: 'Anthropic',
    description: 'The default — Claude models with your Claude plan or Anthropic API key. Nothing to set up.',
    kind: 'anthropic',
    color: '#D97757',
    monogram: 'C',
    website: 'https://claude.com',
    docsUrl: 'https://code.claude.com/docs',
    regions: [{ id: 'default', label: 'Default', baseUrl: 'https://api.anthropic.com' }],
    authEnv: 'none',
    requiresKey: false,
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', context: 1_000_000, thinking: 'optional', vision: true, recommendedFor: ['main'] },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', context: 1_000_000, thinking: 'optional', vision: true, recommendedFor: ['main'] },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', context: 1_000_000, vision: true, recommendedFor: ['fast'] },
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', context: 1_000_000, vision: true }
    ],
    defaults: { main: 'claude-sonnet-5-5' },
    tags: ['popular'],
    notes: ['Uses your normal Claude sign-in — no API key needed.']
  },
  {
    id: 'kimi',
    name: 'Kimi',
    vendor: 'Moonshot AI',
    description: 'Kimi K3 models with a 1M-token context window. Pay as you go.',
    kind: 'anthropic-compatible',
    color: '#16191E',
    monogram: 'K',
    website: 'https://platform.kimi.ai',
    keyUrl: 'https://platform.kimi.ai/console/api-keys',
    docsUrl: 'https://platform.kimi.ai/docs/guide/claude-code-kimi',
    regions: [
      { id: 'intl', label: 'International', baseUrl: 'https://api.moonshot.ai/anthropic' },
      { id: 'cn', label: 'China', baseUrl: 'https://api.moonshot.cn/anthropic' }
    ],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    keyPlaceholder: 'sk-…',
    models: [
      { id: 'kimi-k3[1m]', label: 'Kimi K3 (1M context)', context: 1_000_000, thinking: 'optional', recommendedFor: ['main'] },
      { id: 'kimi-k3.1-pro', label: 'Kimi K3.1 Pro', context: 1_000_000, thinking: 'always', notes: 'Flagship model; thinking is always on.' },
      { id: 'kimi-k3', label: 'Kimi K3', context: 1_000_000, thinking: 'optional', recommendedFor: ['fast'] },
      { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', context: 262_144, thinking: 'always', notes: 'Retiring at the end of December 2026.' }
    ],
    defaults: { main: 'kimi-k3[1m]', opus: 'kimi-k3[1m]', sonnet: 'kimi-k3[1m]', haiku: 'kimi-k3', fable: 'kimi-k3[1m]', subagent: 'kimi-k3[1m]' },
    extraEnv: { CLAUDE_CODE_EFFORT_LEVEL: 'max' },
    contextWindow: 1_000_000,
    listModels: { url: 'https://api.moonshot.ai/v1/models', auth: 'bearer', shape: 'openai' },
    tags: ['popular', 'long-context'],
    notes: [
      'Keys from platform.kimi.ai (international) and platform.kimi.com (China) are not interchangeable.',
      'Every model slot is filled in for you — Kimi doesn’t understand Claude model names.'
    ]
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    vendor: 'DeepSeek',
    description: 'Very low-cost models with a 1M context. Off-peak hours are half price.',
    kind: 'anthropic-compatible',
    color: '#4D6BFE',
    monogram: 'DS',
    website: 'https://platform.deepseek.com',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    docsUrl: 'https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code',
    regions: [{ id: 'global', label: 'Global', baseUrl: 'https://api.deepseek.com/anthropic' }],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    keyPlaceholder: 'sk-…',
    models: [
      { id: 'deepseek-flash[1m]', label: 'DeepSeek Flash (1M)', context: 1_000_000, thinking: 'optional', vision: true, recommendedFor: ['main'] },
      { id: 'deepseek-v4-pro[1m]', label: 'DeepSeek V4 Pro (1M)', context: 1_000_000, thinking: 'optional' },
      { id: 'deepseek-flash', label: 'DeepSeek Flash', context: 1_000_000, vision: true, recommendedFor: ['fast'] }
    ],
    defaults: {
      main: 'deepseek-flash[1m]',
      opus: 'deepseek-flash[1m]',
      sonnet: 'deepseek-flash[1m]',
      haiku: 'deepseek-flash',
      fable: 'deepseek-flash[1m]',
      subagent: 'deepseek-flash'
    },
    extraEnv: { CLAUDE_CODE_EFFORT_LEVEL: 'max' },
    contextWindow: 786_432,
    listModels: { url: 'https://api.deepseek.com/models', auth: 'bearer', shape: 'openai' },
    tags: ['cheap', 'long-context', 'popular'],
    notes: ['deepseek-chat and deepseek-reasoner were retired on 2026-07-24.']
  },
  {
    id: 'zai',
    name: 'GLM',
    vendor: 'Z.ai',
    description: 'GLM-5.3 coding models with a 1M context. A monthly coding plan is available.',
    kind: 'anthropic-compatible',
    color: '#2B5BF5',
    monogram: 'Z',
    website: 'https://z.ai',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    docsUrl: 'https://docs.z.ai/devpack/tool/claude',
    regions: [
      { id: 'intl', label: 'International (Z.ai)', baseUrl: 'https://api.z.ai/api/anthropic' },
      { id: 'cn', label: 'China (BigModel)', baseUrl: 'https://open.bigmodel.cn/api/anthropic' }
    ],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    models: [
      { id: 'glm-5.3[1m]', label: 'GLM-5.3 (1M)', context: 1_000_000, thinking: 'optional', recommendedFor: ['main'] },
      { id: 'glm-5.3-flash[1m]', label: 'GLM-5.3 Flash (1M)', context: 1_000_000, vision: true, recommendedFor: ['fast'] }
    ],
    defaults: { main: 'glm-5.3[1m]', opus: 'glm-5.3[1m]', sonnet: 'glm-5.3[1m]', haiku: 'glm-5.3-flash[1m]', fable: 'glm-5.3[1m]', subagent: 'glm-5.3[1m]' },
    extraEnv: { API_TIMEOUT_MS: '3000000', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    contextWindow: 1_000_000,
    tags: ['coding-plan', 'long-context', 'china'],
    notes: ['International and China keys are separate accounts.']
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    vendor: 'OpenRouter',
    description: 'One key for hundreds of models from many providers.',
    kind: 'anthropic-compatible',
    color: '#6467F2',
    monogram: 'OR',
    website: 'https://openrouter.ai',
    keyUrl: 'https://openrouter.ai/settings/keys',
    docsUrl: 'https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration',
    regions: [{ id: 'global', label: 'Global', baseUrl: 'https://openrouter.ai/api' }],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    blankApiKey: true,
    requiresKey: true,
    keyPlaceholder: 'sk-or-v1-…',
    models: [
      { id: 'moonshotai/kimi-k3.1-pro', label: 'Kimi K3.1 Pro', context: 1_048_576, thinking: 'always', recommendedFor: ['main'] },
      { id: 'z-ai/glm-5.3', label: 'GLM-5.3', context: 1_000_000 },
      { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro', context: 1_000_000 },
      { id: 'qwen/qwen3.8-max', label: 'Qwen3.8 Max', context: 1_000_000 },
      { id: 'minimax/minimax-m3.1-flash', label: 'MiniMax M3.1 Flash', context: 1_000_000, recommendedFor: ['fast'] }
    ],
    defaults: {
      main: 'moonshotai/kimi-k3.1-pro',
      opus: 'moonshotai/kimi-k3.1-pro',
      sonnet: 'moonshotai/kimi-k3.1-pro',
      haiku: 'minimax/minimax-m3.1-flash',
      fable: 'moonshotai/kimi-k3.1-pro',
      subagent: 'moonshotai/kimi-k3.1-pro'
    },
    extraEnv: { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' },
    listModels: { url: 'https://openrouter.ai/api/v1/models', auth: 'none', shape: 'anthropic' },
    tags: ['popular'],
    notes: ['OpenRouter needs the key sent as a Bearer token — Claude Setup takes care of it.']
  },
  {
    id: 'groq',
    name: 'Groq',
    vendor: 'Groq',
    description: 'Extremely fast open models. Works through the built-in translation proxy.',
    kind: 'openai-proxy',
    color: '#F55036',
    monogram: 'G',
    website: 'https://groq.com',
    keyUrl: 'https://console.groq.com/keys',
    docsUrl: 'https://console.groq.com/docs/openai',
    regions: [{ id: 'global', label: 'Global', baseUrl: 'https://api.groq.com/openai/v1' }],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    keyPlaceholder: 'gsk_…',
    models: [
      { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', context: 131_072, thinking: 'optional', recommendedFor: ['main'] },
      { id: 'moonshotai/kimi-k2-instruct-0905', label: 'Kimi K2 Instruct', context: 262_144 },
      { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', context: 131_072, recommendedFor: ['fast'] }
    ],
    defaults: { main: 'openai/gpt-oss-120b', haiku: 'openai/gpt-oss-20b' },
    listModels: { url: '/models', auth: 'bearer', shape: 'openai' },
    tags: ['fast', 'needs-proxy'],
    notes: ['Groq has no Claude-compatible endpoint, so Claude Setup runs a small local translator (the proxy) for it.']
  },
  {
    id: 'ollama',
    name: 'Ollama',
    vendor: 'Ollama',
    description: 'Run open models on your own computer — free and private.',
    kind: 'local',
    color: '#1A1A1A',
    monogram: 'O',
    website: 'https://ollama.com',
    docsUrl: 'https://docs.ollama.com/integrations/claude-code',
    regions: [
      { id: 'local', label: 'This computer', baseUrl: 'http://localhost:11434' },
      { id: 'cloud', label: 'Ollama Cloud', baseUrl: 'https://ollama.com' }
    ],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    blankApiKey: true,
    requiresKey: false,
    defaultKey: 'ollama',
    models: [
      { id: 'qwen3.5', label: 'Qwen 3.5', context: 65_536, recommendedFor: ['main'] },
      { id: 'gpt-oss:20b', label: 'GPT-OSS 20B', context: 131_072, recommendedFor: ['fast'] },
      { id: 'kimi-k2.7-code:cloud', label: 'Kimi K2.7 Code (cloud)', context: 262_144 }
    ],
    defaults: { main: 'qwen3.5' },
    listModels: { url: '/api/tags', auth: 'none', shape: 'ollama' },
    tags: ['local', 'free'],
    notes: ['Coding needs at least a 64K context: start Ollama with OLLAMA_CONTEXT_LENGTH=64000.']
  },
  {
    id: 'qwen',
    name: 'Alibaba Qwen',
    vendor: 'Alibaba Cloud Model Studio',
    description: 'Qwen 3.7 / 3.8 models from Alibaba Cloud Model Studio, billed per use.',
    kind: 'anthropic-compatible',
    color: '#615CED',
    monogram: 'Q',
    website: 'https://www.alibabacloud.com/en/product/modelstudio',
    keyUrl: 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/settings/api-key',
    docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/claude-code',
    regions: [
      { id: 'singapore', label: 'Singapore', baseUrl: 'https://dashscope-intl.aliyuncs.com/apps/anthropic' },
      { id: 'us', label: 'United States (Virginia)', baseUrl: 'https://dashscope-us.aliyuncs.com/apps/anthropic' },
      { id: 'china', label: 'China (Beijing)', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic' },
      { id: 'hongkong', label: 'Hong Kong', baseUrl: 'https://cn-hongkong.dashscope.aliyuncs.com/apps/anthropic' }
    ],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    keyPlaceholder: 'sk-…',
    models: [
      { id: 'qwen3.8-max', label: 'Qwen3.8 Max', thinking: 'optional', recommendedFor: ['main'] },
      { id: 'qwen3.7-max', label: 'Qwen3.7 Max', thinking: 'optional' },
      { id: 'qwen3.8-flash', label: 'Qwen3.8 Flash', thinking: 'optional', vision: true, recommendedFor: ['fast'] }
    ],
    defaults: { main: 'qwen3.8-max', opus: 'qwen3.8-max', sonnet: 'qwen3.8-max', haiku: 'qwen3.8-flash', fable: 'qwen3.8-max', subagent: 'qwen3.8-max' },
    listModels: { url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models', auth: 'bearer', shape: 'openai' },
    tags: ['popular', 'china'],
    notes: ['Keys belong to one region — a Singapore key won’t work in the US or China region.']
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    vendor: 'MiniMax',
    description: 'MiniMax M3.1 Flash — fast, cheap, 1M-token context. Works with M Plan subscriptions.',
    kind: 'anthropic-compatible',
    color: '#F23F5D',
    monogram: 'MM',
    website: 'https://platform.minimax.io',
    keyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    docsUrl: 'https://platform.minimax.io/docs/m-plan/claude-code',
    regions: [
      { id: 'global', label: 'International (minimax.io)', baseUrl: 'https://api.minimax.io/anthropic' },
      { id: 'china', label: 'China (minimax.cn)', baseUrl: 'https://api.minimax.cn/anthropic' }
    ],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    keyPlaceholder: 'Your MiniMax API or subscription key',
    models: [
      {
        id: 'MiniMax-M3.1-Flash[1m]',
        label: 'MiniMax M3.1 Flash',
        context: 1_048_576,
        thinking: 'always',
        vision: true,
        recommendedFor: ['main', 'fast'],
        notes: 'Always thinks; switching thinking off has no effect.'
      },
      { id: 'MiniMax-M3[1m]', label: 'MiniMax M3', context: 1_048_576, thinking: 'optional', vision: true }
    ],
    defaults: { main: 'MiniMax-M3.1-Flash[1m]' },
    extraEnv: { CLAUDE_CODE_EFFORT_LEVEL: 'max' },
    contextWindow: 524_288,
    listModels: { url: '/v1/models', auth: 'x-api-key', shape: 'anthropic' },
    tags: ['cheap', 'fast', 'coding-plan', 'long-context', 'china'],
    notes: ['Works with pay-as-you-go keys and with M Plan subscription keys.']
  },
  {
    id: 'openai',
    name: 'OpenAI',
    vendor: 'OpenAI',
    description: 'GPT-6 models through Claude Setup’s local translation proxy.',
    kind: 'openai-proxy',
    color: '#10A37F',
    monogram: 'OA',
    website: 'https://platform.openai.com',
    keyUrl: 'https://platform.openai.com/api-keys',
    docsUrl: 'https://platform.openai.com/docs/models',
    regions: [{ id: 'default', label: 'OpenAI API', baseUrl: 'https://api.openai.com/v1' }],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    keyPlaceholder: 'sk-…',
    models: [
      { id: 'gpt-6.1-sol[1m]', label: 'GPT-6.1 Sol', context: 1_050_000, thinking: 'always', vision: true, recommendedFor: ['main'] },
      { id: 'gpt-6-luna[1m]', label: 'GPT-6 Luna', context: 1_050_000, thinking: 'always', vision: true, recommendedFor: ['fast'] },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', context: 400_000, thinking: 'always', vision: true }
    ],
    defaults: { main: 'gpt-6.1-sol[1m]', haiku: 'gpt-6-luna[1m]' },
    listModels: { url: '/models', auth: 'bearer', shape: 'openai' },
    tags: ['popular', 'needs-proxy'],
    notes: [
      'OpenAI has no Claude-compatible endpoint, so Claude Code talks to Claude Setup’s local proxy, which translates every request.',
      'Keep Claude Setup running (it can stay in the tray) while you use Claude Code.'
    ]
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (this computer)',
    vendor: 'LM Studio',
    description: 'Run local models in LM Studio’s built-in server.',
    kind: 'local',
    color: '#6D28D9',
    monogram: 'LM',
    website: 'https://lmstudio.ai',
    docsUrl: 'https://lmstudio.ai/docs/integrations/claude-code',
    regions: [{ id: 'local', label: 'This computer (port 1234)', baseUrl: 'http://localhost:1234' }],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: false,
    defaultKey: 'lmstudio',
    models: [{ id: 'openai/gpt-oss-20b', label: 'gpt-oss 20B', thinking: 'optional', recommendedFor: ['main', 'fast'] }],
    defaults: { main: 'openai/gpt-oss-20b' },
    listModels: { url: '/v1/models', auth: 'none', shape: 'openai' },
    tags: ['local', 'free'],
    notes: ['Start the server in LM Studio (Developer → Start server) and load a model first.']
  },
  {
    id: 'bedrock',
    name: 'Amazon Bedrock',
    vendor: 'Amazon Web Services',
    description: 'Claude models billed through your AWS account (Claude Code’s built-in Bedrock support).',
    kind: 'cloud',
    color: '#FF9900',
    monogram: 'AB',
    website: 'https://aws.amazon.com/bedrock/',
    docsUrl: 'https://code.claude.com/docs/en/amazon-bedrock',
    regions: [{ id: 'aws', label: 'AWS', baseUrl: '' }],
    authEnv: 'none',
    requiresKey: false,
    keyPlaceholder: 'Bedrock API key (optional)',
    models: [
      { id: 'us.anthropic.claude-opus-5-5', label: 'Claude Opus 5.5', context: 1_000_000, thinking: 'optional', vision: true, recommendedFor: ['main'] },
      { id: 'us.anthropic.claude-sonnet-5-5', label: 'Claude Sonnet 5.5', context: 1_000_000, thinking: 'optional', vision: true },
      { id: 'us.anthropic.claude-haiku-5-5', label: 'Claude Haiku 5.5', context: 1_000_000, thinking: 'optional', vision: true, recommendedFor: ['fast'] }
    ],
    defaults: {
      main: 'us.anthropic.claude-opus-5-5',
      opus: 'us.anthropic.claude-opus-5-5',
      sonnet: 'us.anthropic.claude-sonnet-5-5',
      haiku: 'us.anthropic.claude-haiku-5-5',
      fable: 'us.anthropic.claude-opus-5-5',
      subagent: 'us.anthropic.claude-sonnet-5-5'
    },
    cloudEnv: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' },
    tags: [],
    notes: ['Sign in first with aws sso login, access keys in your environment, or a Bedrock API key.']
  }
]

let profiles: ModelProfile[] = [
  {
    id: 'prof-kimi',
    name: 'Kimi K3',
    providerId: 'kimi',
    regionId: 'intl',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    keyRef: 'model:prof-kimi',
    hasKey: true,
    models: { main: 'kimi-k3[1m]', opus: 'kimi-k3[1m]', sonnet: 'kimi-k3[1m]', haiku: 'kimi-k3', fable: 'kimi-k3[1m]', subagent: 'kimi-k3[1m]' },
    compatMode: true,
    extraEnv: { CLAUDE_CODE_EFFORT_LEVEL: 'max' },
    contextWindow: 1_000_000,
    useKeyHelper: false,
    createdAt: daysAgo(4),
    updatedAt: daysAgo(4)
  }
]

let status: ModelStatus = { mode: 'anthropic', vscodeConfigured: false, vscodeMatches: true, problems: [], shellOverrides: [] }

const CAVEAT = 'Anthropic doesn’t support using Claude Code with non-Claude models — some features may not work as expected.'

function provider(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((p) => p.id === id)
}

export const modelsApi: ModelsApi = {
  async providers() {
    return clone(PROVIDERS)
  },

  async profiles() {
    return clone(profiles)
  },

  async saveProfile(input) {
    await sleep(250)
    const preset = provider(input.providerId)
    if (!preset) throw new Error('Unknown provider. Pick one from the list.')
    if (!input.name.trim()) throw new Error('Give this setup a name, e.g. “Kimi for work”.')
    if (!input.models.main?.trim()) throw new Error('Choose a main model.')
    const id = input.id ?? uid('prof')
    const keyRef = `model:${id}`
    if (input.apiKey) storeSecret(keyRef, input.apiKey.trim())
    const region = preset.regions.find((r) => r.id === input.regionId) ?? preset.regions[0]
    const existing = profiles.find((p) => p.id === id)
    const now = new Date().toISOString()
    const profile: ModelProfile = {
      id,
      name: input.name.trim(),
      providerId: preset.id,
      regionId: region?.id,
      baseUrl: input.baseUrl?.trim() || region?.baseUrl || '',
      keyRef: preset.requiresKey || input.apiKey ? keyRef : undefined,
      hasKey: secretExists(keyRef),
      models: { ...preset.defaults, ...input.models },
      compatMode: input.compatMode ?? true,
      extraEnv: { ...(preset.extraEnv ?? {}), ...(input.extraEnv ?? {}) },
      contextWindow: input.contextWindow ?? preset.contextWindow,
      useKeyHelper: input.useKeyHelper ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    profiles = existing ? profiles.map((p) => (p.id === id ? profile : p)) : [...profiles, profile]
    return clone(profile)
  },

  async deleteProfile(id): Promise<OpResult> {
    const profile = profiles.find((p) => p.id === id)
    if (!profile) return { ok: false, message: 'That setup no longer exists.' }
    if (status.profileId === id) return { ok: false, message: 'This setup is in use. Switch back to Claude first, then delete it.' }
    profiles = profiles.filter((p) => p.id !== id)
    storeSecret(`model:${id}`, null)
    return { ok: true, message: `Deleted “${profile.name}”.` }
  },

  async status() {
    return clone(status)
  },

  async apply(req): Promise<ApplyModelResult> {
    const profile = profiles.find((p) => p.id === req.profileId)
    if (!profile) return { ok: false, results: [], warnings: ['That setup no longer exists.'] }
    const preset = provider(profile.providerId)
    if (preset?.requiresKey && !profile.hasKey) {
      return { ok: false, results: req.targets.map((target) => ({ target, ok: false, message: 'Add an API key first.' })), warnings: [] }
    }
    await sleep(600)
    const results = req.targets.map((target: ModelTarget) => {
      const configPath = target === 'claude-code' ? claudeSettingsPath() : vscodeSettingsPath()
      return {
        target,
        ok: true,
        message: target === 'claude-code' ? 'Claude Code will use this model next time it starts.' : 'The VS Code extension will use it after you reload VS Code.',
        configPath,
        backupId: recordBackup(`Use ${profile.name} in ${target === 'claude-code' ? 'Claude Code' : 'VS Code'}`, [configPath])
      }
    })
    const proxyStarted = preset?.kind === 'openai-proxy'
    if (proxyStarted) startProxy()
    status = {
      mode: preset?.kind === 'cloud' ? 'cloud' : preset?.kind === 'anthropic' ? 'anthropic' : 'custom',
      profileId: profile.id,
      providerId: profile.providerId,
      providerName: preset?.name,
      baseUrl: proxyStarted ? 'http://127.0.0.1:3460' : profile.baseUrl,
      model: profile.models.main,
      authVar: profile.useKeyHelper ? 'apiKeyHelper' : 'ANTHROPIC_AUTH_TOKEN',
      vscodeConfigured: req.targets.includes('vscode'),
      vscodeMatches: req.targets.includes('vscode'),
      problems: [],
      shellOverrides: []
    }
    log('info', 'models', `Applied ${profile.name}`)
    return clone({ ok: true, results, warnings: preset?.kind === 'anthropic' ? [] : [CAVEAT], proxyStarted })
  },

  async reset(targets): Promise<ApplyModelResult> {
    await sleep(450)
    const results = targets.map((target) => {
      const configPath = target === 'claude-code' ? claudeSettingsPath() : vscodeSettingsPath()
      return {
        target,
        ok: true,
        message: 'Back to Claude.',
        configPath,
        backupId: recordBackup(`Reset models in ${target === 'claude-code' ? 'Claude Code' : 'VS Code'}`, [configPath])
      }
    })
    status = { mode: 'anthropic', vscodeConfigured: false, vscodeMatches: true, problems: [], shellOverrides: [] }
    return clone({ ok: true, results, warnings: [] })
  },

  async listModels(input): Promise<ModelPreset[]> {
    await sleep(500)
    const profile = input.profileId ? profiles.find((p) => p.id === input.profileId) : undefined
    const preset = provider(input.providerId ?? profile?.providerId ?? '')
    if (!preset) return []
    if (preset.id === 'ollama' && (input.baseUrl ?? profile?.baseUrl ?? '').includes('localhost')) {
      throw new Error('Couldn’t reach Ollama at http://localhost:11434. Is the Ollama app running?')
    }
    return clone(preset.models)
  },

  async testConnection(input): Promise<ConnectionTestResult> {
    const started = Date.now()
    await sleep(900 + Math.random() * 600)
    const ms = Date.now() - started
    const profile = input.profileId ? profiles.find((p) => p.id === input.profileId) : undefined
    const preset = provider(input.providerId ?? profile?.providerId ?? '')
    const baseUrl = input.baseUrl ?? profile?.baseUrl ?? preset?.regions[0]?.baseUrl ?? ''
    const key = input.apiKey ?? (profile?.hasKey ? 'stored' : '')
    if (preset?.id === 'ollama' && baseUrl.includes('localhost')) {
      return { ok: false, ms, verdict: 'network', message: 'Couldn’t reach Ollama on this computer. Start the Ollama app and try again.' }
    }
    if (preset?.requiresKey && !key) {
      return { ok: false, ms, verdict: 'bad-key', status: 401, message: 'Add your API key first.' }
    }
    if (input.apiKey && (input.apiKey.length < 12 || /^bad|invalid/i.test(input.apiKey))) {
      return { ok: false, ms, status: 401, verdict: 'bad-key', message: 'The key was rejected. Make sure you copied the whole key.' }
    }
    if (input.model && !preset?.models.some((m) => m.id === input.model)) {
      return { ok: false, ms, status: 400, verdict: 'bad-model', message: `The provider doesn’t know the model “${input.model}”.` }
    }
    return { ok: true, ms, status: 200, verdict: 'ok', message: 'Connected. The model replied.', sample: 'Hi! I’m ready to help with your code.' }
  }
}
