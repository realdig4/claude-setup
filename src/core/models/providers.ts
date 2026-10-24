/**
 * Provider presets: everything Claude Setup knows about each model provider (verified 2026-10-23).
 *
 * Conventions used by this data:
 * - `regions[].baseUrl` is ANTHROPIC_BASE_URL (never ending in /v1) — or the OpenAI base including /v1 for
 *   kind 'openai-proxy'. An empty baseUrl means "the user types the address" (custom endpoints).
 * - `defaults` always lists every slot. For user-defined endpoints the model is unknown, so every slot is ''
 *   and the UI must ask for a model name (listModels can fetch the server's list).
 * - `listModels.url` is absolute, a path appended to the region baseUrl ('/…'), or starts with '{origin}', which is
 *   replaced by the region baseUrl's origin (for providers whose model list lives outside the Anthropic path).
 * - `cloudEnv` (kind 'cloud') is a template: values in <angle brackets> must be filled in by the user (profile extra
 *   env overrides them); other values are editable defaults.
 * - `[1m]` on a model id tells Claude Code the model has a 1M-token window. Claude Code strips it before sending.
 */
import type { ModelPreset, ModelSlot, ProviderPreset, ProviderRegion, ProxyUpstream } from '@shared/types'
import { normalizeBaseUrl, stripContextSuffix, stripTrailingV1 } from './urls'

/** Anthropic's own statement, shown wherever a third-party model is configured. */
export const ANTHROPIC_CAVEAT =
  'Heads-up from Anthropic: it "doesn\'t endorse, maintain, or audit third-party gateway products, and doesn\'t support ' +
  'routing Claude Code to non-Claude models through any gateway." Claude Setup is not affiliated with Anthropic.'

/** Every slot set to `main`, with overrides. */
function slots(main: string, over: Partial<Record<ModelSlot, string>> = {}): Record<ModelSlot, string> {
  return { main, opus: main, sonnet: main, haiku: main, fable: main, subagent: main, ...over }
}

const M = 1_048_576

const CLAUDE_MODELS: ModelPreset[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', context: 1_000_000, thinking: 'optional', vision: true, recommendedFor: ['main'] },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', context: 1_000_000, thinking: 'optional', vision: true, recommendedFor: ['main'] },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', context: 1_000_000, thinking: 'optional', vision: true, recommendedFor: ['fast'] },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', context: 1_000_000, thinking: 'optional', vision: true }
]

const PRESET_DATA: ProviderPreset[] = [
  // ───────────────────────────── Anthropic (default) ─────────────────────────────
  {
    id: 'anthropic',
    name: 'Claude (Anthropic)',
    vendor: 'Anthropic',
    description: "Claude Code's normal setup: Claude models with your Claude account or an Anthropic API key.",
    kind: 'anthropic',
    color: '#D97757',
    monogram: 'A',
    website: 'https://claude.com',
    keyUrl: 'https://platform.claude.com/settings/keys',
    docsUrl: 'https://code.claude.com/docs/en/authentication',
    regions: [{ id: 'default', label: 'Anthropic API', baseUrl: 'https://api.anthropic.com' }],
    authEnv: 'ANTHROPIC_API_KEY',
    requiresKey: false,
    keyPlaceholder: 'sk-ant-… (optional)',
    models: CLAUDE_MODELS,
    defaults: slots('claude-opus-5-5', { sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1', subagent: 'claude-sonnet-5-5' }),
    listModels: { url: '/v1/models', auth: 'x-api-key', shape: 'anthropic' },
    tags: ['popular'],
    notes: [
      'Uses your Claude subscription login. Optionally save an Anthropic API key (Claude Console) to pay per use ' +
        'instead — Claude Code asks you to approve a new key once.',
      'Choosing this removes every third-party model setting from Claude Code; Claude Code then picks the best Claude model itself.'
    ]
  },

  // ───────────────────────────── Anthropic-compatible providers ─────────────────────────────
  {
    id: 'moonshot',
    name: 'Kimi (Moonshot API)',
    vendor: 'Moonshot AI',
    description: 'Kimi K3 models with a 1M-token context, pay as you go.',
    kind: 'anthropic-compatible',
    color: '#1783FF',
    monogram: 'K',
    website: 'https://platform.kimi.ai',
    keyUrl: 'https://platform.kimi.ai/console/api-keys',
    docsUrl: 'https://platform.kimi.ai/docs/guide/claude-code-kimi',
    regions: [
      { id: 'global', label: 'International (platform.kimi.ai)', baseUrl: 'https://api.moonshot.ai/anthropic' },
      { id: 'china', label: 'China (platform.kimi.com)', baseUrl: 'https://api.moonshot.cn/anthropic' }
    ],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    keyPlaceholder: 'sk-…',
    models: [
      { id: 'kimi-k3[1m]', label: 'Kimi K3', context: M, thinking: 'optional', vision: true, recommendedFor: ['main', 'fast'] },
      { id: 'kimi-k3.1-pro[1m]', label: 'Kimi K3.1 Pro', context: M, thinking: 'always', vision: true, recommendedFor: ['main'], notes: 'Flagship. Thinking-only: keep thinking switched on.' },
      { id: 'kimi-k3.1-pro-highspeed[1m]', label: 'Kimi K3.1 Pro HighSpeed', context: M, thinking: 'always', notes: 'About 2–3× faster than K3.1 Pro.' },
      { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', context: 262144, thinking: 'always', notes: 'Retiring with the K2 series (closed to new users from 31 Oct 2026).' },
      { id: 'kimi-k2.7-code-highspeed', label: 'Kimi K2.7 Code HighSpeed', context: 262144, thinking: 'always', notes: 'Retiring with the K2 series.' },
      { id: 'kimi-k2.6', label: 'Kimi K2.6', context: 262144, notes: 'Retiring with the K2 series.' }
    ],
    defaults: slots('kimi-k3[1m]'),
    extraEnv: { CLAUDE_CODE_EFFORT_LEVEL: 'max' },
    contextWindow: 1_000_000,
    listModels: { url: '{origin}/v1/models', auth: 'bearer', shape: 'openai' },
    tags: ['popular', 'long-context', 'china'],
    notes: [
      'Keys from platform.kimi.ai (international) and platform.kimi.com (China) are not interchangeable — pick the matching region.',
      "Moonshot's guide maps the fast slot to kimi-k2.7-code, but the K2 series closes to new users on 31 Oct 2026 " +
        "and retires by the end of December 2026, so this preset uses Kimi K3 everywhere.",
      'K3.1 Pro and K2.7 Code are thinking-only: if you see "only type=enabled is allowed", switch thinking back on ' +
        '(Alt+T, or Option+T on a Mac).'
    ]
  },
  {
    id: 'kimi-code',
    name: 'Kimi Code (membership)',
    vendor: 'Moonshot AI',
    description: 'Use your Kimi Code membership quota (Plus plan or higher) in Claude Code.',
    kind: 'anthropic-compatible',
    color: '#0F172A',
    monogram: 'KC',
    website: 'https://www.kimi.com/code',
    keyUrl: 'https://www.kimi.com/code/console',
    docsUrl: 'https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html',
    regions: [
      { id: 'global', label: 'International (kimi.ai)', baseUrl: 'https://api.kimi.ai/coding/' },
      { id: 'china', label: 'China (kimi.com)', baseUrl: 'https://api.kimi.com/coding/' }
    ],
    authEnv: 'ANTHROPIC_API_KEY',
    requiresKey: true,
    keyPlaceholder: 'Your Kimi Code API key',
    models: [
      { id: 'k3.1-pro', label: 'K3.1 Pro (256K)', context: 262144, thinking: 'always', recommendedFor: ['main', 'fast'] },
      { id: 'k3.1-pro[1m]', label: 'K3.1 Pro (1M, Pro+ / Allegretto+ plans)', context: M, thinking: 'always' },
      { id: 'k3.1-pro-highspeed[1m]', label: 'K3.1 Pro HighSpeed (Pro+ / Allegretto+ plans)', context: M, thinking: 'always' },
      { id: 'k3', label: 'K3 (256K)', context: 262144, thinking: 'optional' },
      { id: 'k3-256k', label: 'K3 256K', context: 262144, thinking: 'optional' },
      { id: 'kimi-for-coding[1m]', label: 'Kimi for Coding (1M)', context: M },
      { id: 'kimi-for-coding-highspeed', label: 'Kimi for Coding HighSpeed (Pro+ / Allegretto+ plans)', context: 262144 }
    ],
    defaults: slots('k3.1-pro'),
    extraEnv: { CLAUDE_CODE_EFFORT_LEVEL: 'max' },
    contextWindow: 262144,
    listModels: { url: '/v1/models', auth: 'bearer', shape: 'openai' },
    tags: ['coding-plan', 'long-context', 'china'],
    notes: [
      'Needs a Plus (Moderato) plan or higher — Go plans have no coding quota. Plus gives a 256K context; on Pro+ / ' +
        'Allegretto+ pick a 1M model.',
      "Kimi's terms forbid changing the User-Agent, so this key is never sent through Claude Setup's translation proxy.",
      'Claude Code asks once to approve this API key: run claude in a terminal, choose Yes, and restart VS Code afterwards.'
    ]
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    vendor: 'DeepSeek',
    description: 'DeepSeek V4.1 Flash and V4 Pro — very low prices, 1M-token context.',
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
      { id: 'deepseek-flash[1m]', label: 'DeepSeek V4.1 Flash', context: M, thinking: 'optional', vision: true, recommendedFor: ['main'] },
      { id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash (background tasks)', context: M, thinking: 'optional', vision: true, recommendedFor: ['fast'] },
      { id: 'deepseek-v4-pro[1m]', label: 'DeepSeek V4 Pro', context: M, thinking: 'optional', vision: false, notes: 'Stronger, about 4× the price of Flash. No image input.' }
    ],
    defaults: slots('deepseek-flash[1m]', { haiku: 'deepseek-flash', subagent: 'deepseek-flash' }),
    extraEnv: { CLAUDE_CODE_EFFORT_LEVEL: 'max' },
    contextWindow: 786432,
    listModels: { url: '{origin}/models', auth: 'bearer', shape: 'openai' },
    tags: ['popular', 'cheap', 'long-context'],
    notes: [
      'Off-peak prices are half price (peak: 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday).',
      'deepseek-chat and deepseek-reasoner were discontinued on 24 Jul 2026.',
      'Claude model names are mapped on the server (claude-opus* → V4 Pro at Pro prices), so stray Claude ids still work.'
    ]
  },
  {
    id: 'zai',
    name: 'Z.ai GLM',
    vendor: 'Z.ai (Zhipu)',
    description: 'GLM-5.3 coding models with a 1M-token context — works with the GLM Coding Plan.',
    kind: 'anthropic-compatible',
    color: '#3D5AFE',
    monogram: 'Z',
    website: 'https://z.ai',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    docsUrl: 'https://docs.z.ai/devpack/tool/claude',
    regions: [
      { id: 'global', label: 'International (z.ai)', baseUrl: 'https://api.z.ai/api/anthropic' },
      { id: 'china', label: 'China (BigModel, bigmodel.cn)', baseUrl: 'https://open.bigmodel.cn/api/anthropic' }
    ],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    keyPlaceholder: 'Your Z.ai API key',
    models: [
      { id: 'glm-5.3[1m]', label: 'GLM-5.3', context: M, thinking: 'optional', vision: false, recommendedFor: ['main'] },
      { id: 'glm-5.3-flash[1m]', label: 'GLM-5.3 Flash', context: M, thinking: 'optional', vision: true, recommendedFor: ['fast'] }
    ],
    defaults: slots('glm-5.3[1m]', { haiku: 'glm-5.3-flash[1m]' }),
    extraEnv: { API_TIMEOUT_MS: '3000000' },
    contextWindow: 1_000_000,
    listModels: { url: '/v1/models', auth: 'bearer', shape: 'anthropic' },
    tags: ['popular', 'coding-plan', 'long-context', 'china'],
    notes: [
      'Use a Coding Plan key (API Keys → Personal Coding Plan) to spend plan credits. A standard key is billed pay-as-you-go, even here.',
      'China: create the key on bigmodel.cn and pick the China region. Z.ai also recommends ' +
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 there (add it in Advanced) — note that it turns off Claude Code ' +
        'auto-updates.',
      'Requests for older GLM versions are routed to GLM-5.3 automatically.'
    ]
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
      { id: 'MiniMax-M3.1-Flash[1m]', label: 'MiniMax M3.1 Flash', context: M, thinking: 'always', vision: true, recommendedFor: ['main', 'fast'], notes: 'Always thinks; switching thinking off has no effect.' },
      { id: 'MiniMax-M3[1m]', label: 'MiniMax M3', context: M, thinking: 'optional', vision: true }
    ],
    defaults: slots('MiniMax-M3.1-Flash[1m]'),
    extraEnv: { CLAUDE_CODE_EFFORT_LEVEL: 'max' },
    contextWindow: 524288,
    listModels: { url: '/v1/models', auth: 'x-api-key', shape: 'anthropic' },
    tags: ['cheap', 'fast', 'coding-plan', 'long-context', 'china'],
    notes: [
      'Works with pay-as-you-go keys and with M Plan / Token Plan subscription keys (platform.minimax.io/console/plan).',
      'MiniMax-M2.5 and M2.7 closed to new users on 19 Oct 2026 and retire on 18 Nov 2026.'
    ]
  },
  {
    id: 'qwen',
    name: 'Alibaba Qwen (pay as you go)',
    vendor: 'Alibaba Cloud Model Studio',
    description: 'Qwen 3.7 / 3.8 models from Alibaba Cloud Model Studio (DashScope), billed per use.',
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
      { id: 'qwen3.7-max', label: 'Qwen3.7 Max', thinking: 'optional', recommendedFor: ['main'] },
      { id: 'qwen3.8-max', label: 'Qwen3.8 Max', thinking: 'optional', recommendedFor: ['main'] },
      { id: 'qwen3.7-plus', label: 'Qwen3.7 Plus', thinking: 'optional', vision: true },
      { id: 'qwen3.8-flash', label: 'Qwen3.8 Flash', thinking: 'optional', vision: true, recommendedFor: ['fast'] },
      { id: 'qwen3.6-flash', label: 'Qwen3.6 Flash', thinking: 'optional', vision: true, recommendedFor: ['fast'] },
      { id: 'qwen3-coder-flash', label: 'Qwen3 Coder Flash' }
    ],
    defaults: slots('qwen3.7-max', { haiku: 'qwen3.6-flash' }),
    listModels: { url: '{origin}/compatible-mode/v1/models', auth: 'bearer', shape: 'openai' },
    tags: ['popular', 'china'],
    notes: [
      "Keys belong to one region — a Singapore key won't work in the US or China region.",
      'For the recommended workspace endpoint, enter ' +
        'https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/apps/anthropic as a custom address.',
      'Coding Plan keys (sk-sp-…) need the "Alibaba Qwen Coding Plan" provider instead.'
    ]
  },
  {
    id: 'qwen-coding',
    name: 'Alibaba Qwen Coding Plan',
    vendor: 'Alibaba Cloud Model Studio',
    description: 'Monthly Qwen Coding Plan (sk-sp- keys) — Qwen3.7 Plus and partner models.',
    kind: 'anthropic-compatible',
    color: '#4F46E5',
    monogram: 'QC',
    website: 'https://www.alibabacloud.com/help/en/model-studio/coding-plan',
    docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/coding-plan',
    regions: [
      { id: 'global', label: 'International', baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic' },
      { id: 'china', label: 'China', baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic' }
    ],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    keyPlaceholder: 'sk-sp-…',
    models: [
      { id: 'qwen3.7-plus', label: 'Qwen3.7 Plus', thinking: 'optional', vision: true, recommendedFor: ['main', 'fast'] },
      { id: 'qwen3.6-plus', label: 'Qwen3.6 Plus', thinking: 'optional', vision: true },
      { id: 'qwen3.5-plus', label: 'Qwen3.5 Plus', thinking: 'optional', vision: true },
      { id: 'glm-5', label: 'GLM-5 (on the Coding Plan)', thinking: 'optional' }
    ],
    defaults: slots('qwen3.7-plus'),
    listModels: { url: '{origin}/v1/models', auth: 'none', shape: 'openai' },
    tags: ['coding-plan', 'china'],
    notes: [
      "Needs a Coding Plan key (sk-sp-…); pay-as-you-go keys won't work here.",
      "The plan's terms forbid scripts and backends: use it interactively only. Claude Setup never routes it through its proxy."
    ]
  },
  {
    id: 'qwen-token-plan',
    name: 'Alibaba Qwen Token Plan',
    vendor: 'Alibaba Cloud Model Studio',
    description: 'Qwen Token Plan with automatic model selection.',
    kind: 'anthropic-compatible',
    color: '#7C3AED',
    monogram: 'QT',
    docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/claude-code',
    regions: [
      { id: 'singapore', label: 'Singapore', baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic' },
      { id: 'china', label: 'China (Beijing, Team edition)', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic' }
    ],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    keyPlaceholder: 'Your Token Plan key',
    models: [
      { id: 'auto', label: 'Auto (plan picks the model)', recommendedFor: ['main'] },
      { id: 'qwen3.8-max', label: 'Qwen3.8 Max', thinking: 'optional' },
      { id: 'qwen3.8-flash', label: 'Qwen3.8 Flash', thinking: 'optional', vision: true },
      { id: 'qwen3.6-flash', label: 'Qwen3.6 Flash', thinking: 'optional', vision: true, recommendedFor: ['fast'] }
    ],
    defaults: slots('auto', { opus: 'qwen3.8-max', sonnet: 'qwen3.8-flash', haiku: 'qwen3.6-flash', fable: 'qwen3.8-max' }),
    extraEnv: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '983616' },
    tags: ['coding-plan', 'china'],
    notes: ['Model listing is not available for the Token Plan; the documented models are used.']
  },
  {
    id: 'mimo',
    name: 'Xiaomi MiMo',
    vendor: 'Xiaomi',
    description: 'MiMo V2.6 Pro and Flash — 1M-token context, pay as you go or Token Plan.',
    kind: 'anthropic-compatible',
    color: '#FF6900',
    monogram: 'Mi',
    website: 'https://platform.xiaomimimo.com',
    keyUrl: 'https://platform.xiaomimimo.com/#/console/api-keys',
    docsUrl: 'https://mimo.mi.com/static/docs/tokenplan/integration/claudecode.md',
    regions: [
      { id: 'payg', label: 'Pay as you go (sk- keys)', baseUrl: 'https://api.xiaomimimo.com/anthropic' },
      { id: 'token-sgp', label: 'Token Plan — Singapore (tp- keys)', baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic' },
      { id: 'token-ams', label: 'Token Plan — Europe (tp- keys)', baseUrl: 'https://token-plan-ams.xiaomimimo.com/anthropic' },
      { id: 'token-cn', label: 'Token Plan — China (tp- keys)', baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic' }
    ],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    keyPlaceholder: 'sk-… or tp-…',
    models: [
      { id: 'mimo-v2.6-pro[1m]', label: 'MiMo V2.6 Pro', context: 1_050_000, thinking: 'optional', vision: true, recommendedFor: ['main'] },
      { id: 'mimo-v2.6-flash[1m]', label: 'MiMo V2.6 Flash', context: 1_050_000, thinking: 'optional', vision: true, recommendedFor: ['fast'] },
      { id: 'mimo-v2.6-pro-ultraspeed[1m]', label: 'MiMo V2.6 Pro UltraSpeed', context: M, thinking: 'optional', vision: true }
    ],
    defaults: slots('mimo-v2.6-pro[1m]', { haiku: 'mimo-v2.6-flash[1m]' }),
    contextWindow: 1_000_000,
    listModels: { url: '{origin}/v1/models', auth: 'bearer', shape: 'openai' },
    tags: ['cheap', 'coding-plan', 'long-context', 'china'],
    notes: [
      "Pay-as-you-go keys start with sk-; Token Plan keys start with tp- (ttp- for teams). They can't be mixed — pick the matching region.",
      'mimo-v2.5 models were deprecated on 21 Oct 2026.'
    ]
  },
  {
    id: 'streamlake',
    name: 'StreamLake KAT-Coder',
    vendor: 'StreamLake (Kuaishou)',
    description: 'KAT-Coder Pro V2.5, a coding model from Kuaishou.',
    kind: 'anthropic-compatible',
    color: '#FF5A1F',
    monogram: 'SL',
    website: 'https://www.streamlake.ai',
    keyUrl: 'https://console.streamlake.ai/console/home/index',
    docsUrl: 'https://www.streamlake.ai/document/DOC/mg6k6nlp8j6qxicx4c9',
    regions: [
      {
        id: 'payg',
        label: 'Pay as you go',
        baseUrl: 'https://vanchin.streamlake.ai/api/gateway/v1/endpoints/kat-coder-pro-v2.5/claude-code-proxy'
      },
      { id: 'plan', label: 'Coding Plan', baseUrl: 'https://vanchin.streamlake.ai/api/gateway/coding/kat-coder-pro-v2.5/claude-code-proxy' }
    ],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    keyPlaceholder: 'Your StreamLake API key',
    models: [{ id: 'kat-coder-pro-v2.5', label: 'KAT-Coder Pro V2.5', recommendedFor: ['main', 'fast'] }],
    defaults: slots('kat-coder-pro-v2.5'),
    extraEnv: { API_TIMEOUT_MS: '3000000' },
    tags: ['coding-plan'],
    notes: ["StreamLake doesn't offer a model list; the documented model is used."]
  },
  {
    id: 'volcengine',
    name: 'Volcengine Ark Coding Plan',
    vendor: 'ByteDance (Volcengine)',
    description: 'Doubao Seed, GLM, DeepSeek and Kimi models on the Volcengine Ark Coding Plan (mainland China).',
    kind: 'anthropic-compatible',
    color: '#1664FF',
    monogram: 'VE',
    website: 'https://www.volcengine.com/product/ark',
    keyUrl: 'https://console.volcengine.com/ark',
    docsUrl: 'https://www.volcengine.com/docs/82379/1928262',
    regions: [{ id: 'cn-beijing', label: 'China (Beijing)', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding' }],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    keyPlaceholder: 'Your Ark API key',
    models: [
      { id: 'ark-code-latest', label: 'Ark Code (model chosen in the Ark console, supports Auto)', recommendedFor: ['main'] },
      { id: 'doubao-seed-2.1-pro', label: 'Doubao Seed 2.1 Pro', thinking: 'optional' },
      { id: 'doubao-seed-2.1-lite', label: 'Doubao Seed 2.1 Lite', thinking: 'optional', recommendedFor: ['fast'] },
      { id: 'glm-5.3[1m]', label: 'GLM-5.3', context: M, thinking: 'optional' },
      { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash', thinking: 'optional', recommendedFor: ['fast'] },
      { id: 'deepseek-v4-pro[1m]', label: 'DeepSeek V4 Pro', context: M, thinking: 'optional' },
      { id: 'deepseek-v4.1-flash[1m]', label: 'DeepSeek V4.1 Flash', context: M, thinking: 'optional' },
      { id: 'kimi-k3', label: 'Kimi K3', thinking: 'optional' }
    ],
    defaults: slots('ark-code-latest', { haiku: 'doubao-seed-2.1-lite' }),
    extraEnv: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
    tags: ['coding-plan', 'china'],
    notes: [
      "Coding Plan only. Don't use the …/api/v3 endpoint: requests there are billed pay-as-you-go.",
      'The plan is for interactive coding tools only — scripted or proxied use risks a ban.',
      'Following Volcengine\'s guide this also turns off Claude Code auto-updates and telemetry ' +
        '(CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).',
      'If Claude Code says "The API key format is incorrect", run /logout once.'
    ]
  },
  {
    id: 'byteplus',
    name: 'BytePlus ModelArk Coding Plan',
    vendor: 'ByteDance (BytePlus)',
    description: 'Seed, GLM and DeepSeek models on the BytePlus ModelArk Coding Plan (international).',
    kind: 'anthropic-compatible',
    color: '#0EA5E9',
    monogram: 'BP',
    website: 'https://www.byteplus.com/en/product/modelark',
    keyUrl: 'https://ai.byteplus.com/ark/region:ap-southeast-1/apikey',
    docsUrl: 'https://docs.byteplus.com/en/docs/ModelArk/1928262',
    regions: [{ id: 'ap-southeast', label: 'Southeast Asia', baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/coding' }],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    keyPlaceholder: 'Your ModelArk API key',
    models: [
      { id: 'ark-code-latest', label: 'Ark Code (model chosen in the console)', recommendedFor: ['main'] },
      { id: 'dola-seed-2.0-pro', label: 'Dola Seed 2.0 Pro', thinking: 'optional' },
      { id: 'dola-seed-2.0-code', label: 'Dola Seed 2.0 Code', thinking: 'optional' },
      { id: 'dola-seed-2.0-lite', label: 'Dola Seed 2.0 Lite', thinking: 'optional', recommendedFor: ['fast'] },
      { id: 'bytedance-seed-code', label: 'ByteDance Seed Code' },
      { id: 'glm-5.2[1m]', label: 'GLM-5.2', context: M, thinking: 'optional' },
      { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash', thinking: 'optional', recommendedFor: ['fast'] },
      { id: 'deepseek-v4-pro[1m]', label: 'DeepSeek V4 Pro', context: M, thinking: 'optional' },
      { id: 'deepseek-v4.1-flash[1m]', label: 'DeepSeek V4.1 Flash', context: M, thinking: 'optional' }
    ],
    defaults: slots('ark-code-latest', { haiku: 'dola-seed-2.0-lite' }),
    tags: ['coding-plan'],
    notes: [
      "Coding Plan only. Don't use the …/api/v3 endpoint: requests there are billed pay-as-you-go.",
      'The plan is for interactive coding tools only — scripted or proxied use risks a ban.',
      'If Claude Code says "The API key format is incorrect", run /logout once.'
    ]
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    vendor: 'SiliconFlow',
    description: 'Open models such as DeepSeek V4 Pro hosted by SiliconFlow.',
    kind: 'anthropic-compatible',
    color: '#8B5CF6',
    monogram: 'SF',
    website: 'https://www.siliconflow.com',
    keyUrl: 'https://cloud.siliconflow.com/account/ak',
    docsUrl: 'https://docs.siliconflow.com/en/usercases/use-siliconcloud-in-ClaudeCode',
    regions: [
      { id: 'global', label: 'International (siliconflow.com)', baseUrl: 'https://api.siliconflow.com' },
      { id: 'china', label: 'China (siliconflow.cn)', baseUrl: 'https://api.siliconflow.cn' }
    ],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    keyPlaceholder: 'sk-…',
    models: [{ id: 'deepseek-ai/DeepSeek-V4-Pro-0813', label: 'DeepSeek V4 Pro (0813)', thinking: 'optional', recommendedFor: ['main', 'fast'] }],
    defaults: slots('deepseek-ai/DeepSeek-V4-Pro-0813'),
    listModels: { url: '/v1/models', auth: 'bearer', shape: 'openai' },
    tags: ['cheap', 'china'],
    notes: [
      "Don't add [1m] to SiliconFlow model ids.",
      "The China endpoint (siliconflow.cn) answers but hasn't been verified with Claude Code."
    ]
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    vendor: 'OpenRouter',
    description: 'One key for hundreds of models — GLM, Kimi, DeepSeek, Qwen, Claude and more.',
    kind: 'anthropic-compatible',
    color: '#6366F1',
    monogram: 'OR',
    website: 'https://openrouter.ai',
    keyUrl: 'https://openrouter.ai/settings/keys',
    docsUrl: 'https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration',
    regions: [{ id: 'default', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api' }],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    blankApiKey: true,
    requiresKey: true,
    keyPlaceholder: 'sk-or-…',
    models: [
      { id: 'z-ai/glm-5.3[1m]', label: 'GLM-5.3 (Z.ai)', context: M, thinking: 'optional', recommendedFor: ['main'] },
      { id: 'z-ai/glm-5.3-flash[1m]', label: 'GLM-5.3 Flash (Z.ai)', context: M, thinking: 'optional', vision: true, recommendedFor: ['fast'] },
      { id: 'moonshotai/kimi-k3.1-pro[1m]', label: 'Kimi K3.1 Pro (Moonshot)', context: M, thinking: 'always', vision: true, recommendedFor: ['main'] },
      { id: 'moonshotai/kimi-k3[1m]', label: 'Kimi K3 (Moonshot)', context: M, thinking: 'optional', vision: true },
      { id: 'deepseek/deepseek-v4-pro[1m]', label: 'DeepSeek V4 Pro', context: M, thinking: 'optional' },
      { id: 'deepseek/deepseek-v4.1-flash-1017[1m]', label: 'DeepSeek V4.1 Flash', context: M, thinking: 'optional', vision: true, recommendedFor: ['fast'] },
      { id: 'minimax/minimax-m3.1-flash[1m]', label: 'MiniMax M3.1 Flash', context: M, thinking: 'always', vision: true },
      { id: 'qwen/qwen3.8-max-0902[1m]', label: 'Qwen3.8 Max (0902)', context: 1_000_000, thinking: 'optional', vision: true },
      { id: 'xiaomi/mimo-v2.6-pro[1m]', label: 'MiMo V2.6 Pro (Xiaomi)', context: 1_050_000, thinking: 'optional', vision: true },
      { id: '~anthropic/claude-opus-latest[1m]', label: 'Claude Opus (latest)', context: 1_000_000, thinking: 'optional', vision: true },
      { id: '~anthropic/claude-sonnet-latest[1m]', label: 'Claude Sonnet (latest)', context: 1_000_000, thinking: 'optional', vision: true },
      { id: '~anthropic/claude-haiku-latest', label: 'Claude Haiku (latest)', context: 1_000_000, thinking: 'optional', vision: true },
      { id: '~anthropic/claude-fable-latest[1m]', label: 'Claude Fable (latest)', context: 1_000_000, thinking: 'optional', vision: true }
    ],
    defaults: slots('z-ai/glm-5.3[1m]', { haiku: 'z-ai/glm-5.3-flash[1m]' }),
    extraEnv: { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' },
    listModels: { url: 'https://openrouter.ai/api/v1/models', auth: 'none', shape: 'openai' },
    tags: ['popular'],
    notes: [
      'Claude models work best through OpenRouter; other models are best-effort.',
      'If Claude Code keeps using your Claude login, run /logout once.',
      'For /fast mode add CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK=1 in Advanced settings.'
    ]
  },
  {
    id: 'vercel',
    name: 'Vercel AI Gateway',
    vendor: 'Vercel',
    description: "Hundreds of models through Vercel's AI Gateway, billed to your Vercel team.",
    kind: 'anthropic-compatible',
    color: '#111111',
    monogram: 'V',
    website: 'https://vercel.com/ai-gateway',
    keyUrl: 'https://vercel.com/dashboard',
    docsUrl: 'https://vercel.com/docs/ai-gateway/coding-agents/claude-code',
    regions: [{ id: 'default', label: 'Vercel AI Gateway', baseUrl: 'https://ai-gateway.vercel.sh/claude-code' }],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    blankApiKey: true,
    requiresKey: true,
    keyPlaceholder: 'Your AI Gateway API key',
    models: [
      { id: 'claude-code/moonshotai/kimi-k3[1m]', label: 'Kimi K3 (Moonshot)', context: 1_000_000, thinking: 'optional', recommendedFor: ['main'] },
      { id: 'claude-code/moonshotai/kimi-k3-fast[1m]', label: 'Kimi K3 Fast (Moonshot)', context: 1_000_000, thinking: 'optional', recommendedFor: ['fast'] },
      { id: 'claude-code/moonshotai/kimi-k3.1-pro[1m]', label: 'Kimi K3.1 Pro (Moonshot)', context: M, thinking: 'always' },
      { id: 'claude-code/deepseek/deepseek-v4.1-flash-1017[1m]', label: 'DeepSeek V4.1 Flash', context: M, thinking: 'optional' },
      { id: 'claude-code/deepseek/deepseek-v4-pro-0813[1m]', label: 'DeepSeek V4 Pro (0813)', context: 1_000_000, thinking: 'optional' },
      { id: 'claude-code/zai/glm-5.2[1m]', label: 'GLM-5.2 (Z.ai)', context: 1_000_000, thinking: 'optional' },
      { id: 'claude-code/anthropic/claude-opus-5.5[1m]', label: 'Claude Opus 5.5', context: 1_000_000, thinking: 'optional', vision: true },
      { id: 'claude-code/anthropic/claude-sonnet-5.5[1m]', label: 'Claude Sonnet 5.5', context: 1_000_000, thinking: 'optional', vision: true },
      { id: 'claude-code/anthropic/claude-haiku-5.5[1m]', label: 'Claude Haiku 5.5', context: 1_000_000, thinking: 'optional', vision: true }
    ],
    defaults: slots('claude-code/moonshotai/kimi-k3[1m]', { haiku: 'claude-code/moonshotai/kimi-k3-fast[1m]' }),
    extraEnv: { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' },
    listModels: { url: 'https://ai-gateway.vercel.sh/v1/models', auth: 'none', shape: 'openai' },
    tags: ['popular'],
    notes: [
      'Create the key in your Vercel dashboard → AI Gateway → API keys.',
      'If Claude Code keeps using your Claude login, run /logout once.',
      'Models routed through Bedrock or Vertex need compatibility mode (on by default for non-Claude models).'
    ]
  },
  {
    id: 'ollama-cloud',
    name: 'Ollama Cloud',
    vendor: 'Ollama',
    description: 'Large open models (GLM, Kimi, DeepSeek, MiniMax…) on Ollama\'s cloud — no GPU needed.',
    kind: 'anthropic-compatible',
    color: '#404040',
    monogram: 'OC',
    website: 'https://ollama.com',
    keyUrl: 'https://ollama.com/settings/keys',
    docsUrl: 'https://docs.ollama.com/integrations/claude-code',
    regions: [{ id: 'default', label: 'ollama.com', baseUrl: 'https://ollama.com' }],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    blankApiKey: true,
    requiresKey: true,
    keyPlaceholder: 'Your Ollama API key',
    models: [
      { id: 'glm-5.3', label: 'GLM-5.3', thinking: 'optional', recommendedFor: ['main'] },
      { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash', thinking: 'optional', recommendedFor: ['fast'] },
      { id: 'kimi-k3', label: 'Kimi K3', thinking: 'optional', recommendedFor: ['main'] },
      { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', thinking: 'optional', recommendedFor: ['fast'] },
      { id: 'deepseek-v4-pro:0813', label: 'DeepSeek V4 Pro (0813)', thinking: 'optional' },
      { id: 'minimax-m3.1-flash', label: 'MiniMax M3.1 Flash', thinking: 'always' },
      { id: 'gpt-oss:120b', label: 'gpt-oss 120B', thinking: 'optional' }
    ],
    defaults: slots('glm-5.3', { haiku: 'glm-5.3-flash' }),
    listModels: { url: '/v1/models', auth: 'none', shape: 'openai' },
    tags: ['cheap'],
    notes: [
      'Ollama Cloud needs a key sent as a Bearer token (Claude Setup does this for you).',
      'Not supported by Ollama: prompt caching, PDF documents and image URLs.'
    ]
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    vendor: 'Fireworks AI',
    description: 'Fast hosted open models through Fireworks\' Anthropic-compatible API.',
    kind: 'anthropic-compatible',
    color: '#6720FF',
    monogram: 'FW',
    website: 'https://fireworks.ai',
    docsUrl: 'https://docs.fireworks.ai/tools-sdks/anthropic-compatibility',
    regions: [{ id: 'default', label: 'Fireworks', baseUrl: 'https://api.fireworks.ai/inference' }],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    keyPlaceholder: 'fw_…',
    models: [
      { id: 'accounts/fireworks/models/glm-5p3[1m]', label: 'GLM-5.3', context: M, thinking: 'optional', recommendedFor: ['main'] },
      { id: 'accounts/fireworks/models/glm-5p3-flash[1m]', label: 'GLM-5.3 Flash', context: M, thinking: 'optional', recommendedFor: ['fast'] },
      { id: 'accounts/fireworks/models/kimi-k3[1m]', label: 'Kimi K3', context: M, thinking: 'optional', recommendedFor: ['main'] },
      { id: 'accounts/fireworks/models/deepseek-v4p1-flash[1m]', label: 'DeepSeek V4.1 Flash', context: M, thinking: 'optional' },
      { id: 'accounts/fireworks/models/minimax-m3p1-flash[1m]', label: 'MiniMax M3.1 Flash', context: M, thinking: 'always' },
      { id: 'accounts/fireworks/models/qwen3p8-max', label: 'Qwen3.8 Max', context: 262144, thinking: 'optional' }
    ],
    defaults: slots('accounts/fireworks/models/glm-5p3[1m]', { haiku: 'accounts/fireworks/models/glm-5p3-flash[1m]' }),
    listModels: { url: '/v1/models', auth: 'bearer', shape: 'openai' },
    tags: ['fast'],
    notes: [
      'Fireworks checks the model before the key, so "model not found" can also mean a wrong key.',
      'Token counting and batches are not supported.'
    ]
  },

  // ───────────────────────────── Local servers ─────────────────────────────
  {
    id: 'ollama',
    name: 'Ollama (this computer)',
    vendor: 'Ollama',
    description: 'Run open models locally with Ollama — free and private.',
    kind: 'local',
    color: '#262626',
    monogram: 'O',
    website: 'https://ollama.com',
    docsUrl: 'https://docs.ollama.com/integrations/claude-code',
    regions: [{ id: 'local', label: 'This computer (port 11434)', baseUrl: 'http://localhost:11434' }],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    blankApiKey: true,
    requiresKey: false,
    defaultKey: 'ollama',
    models: [
      { id: 'qwen3.5', label: 'Qwen3.5', thinking: 'optional', recommendedFor: ['main', 'fast'] },
      { id: 'gpt-oss:20b', label: 'gpt-oss 20B', thinking: 'optional' },
      { id: 'qwen3-coder', label: 'Qwen3 Coder' },
      { id: 'glm-5.3:cloud', label: 'GLM-5.3 (Ollama Cloud, needs ollama signin)', thinking: 'optional' },
      { id: 'kimi-k3:cloud', label: 'Kimi K3 (Ollama Cloud, needs ollama signin)', thinking: 'optional' }
    ],
    defaults: slots('qwen3.5'),
    contextWindow: 64000,
    listModels: { url: '/api/tags', auth: 'none', shape: 'ollama' },
    tags: ['local', 'free'],
    notes: [
      'Needs Ollama 0.14 or newer running on this computer. Download models first, e.g. ollama pull qwen3.5.',
      'Coding needs a context of at least 64K: set OLLAMA_CONTEXT_LENGTH=64000 (or use the context slider in the Ollama app).',
      'Not supported by Ollama: prompt caching, PDF documents and image URLs.'
    ]
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (this computer)',
    vendor: 'LM Studio',
    description: "Run local models in LM Studio's built-in server.",
    kind: 'local',
    color: '#6D28D9',
    monogram: 'LM',
    website: 'https://lmstudio.ai',
    docsUrl: 'https://lmstudio.ai/docs/integrations/claude-code',
    regions: [{ id: 'local', label: 'This computer (port 1234)', baseUrl: 'http://localhost:1234' }],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: false,
    defaultKey: 'lmstudio',
    keyPlaceholder: 'Only if "Require Authentication" is on',
    models: [{ id: 'openai/gpt-oss-20b', label: 'gpt-oss 20B', thinking: 'optional', recommendedFor: ['main', 'fast'] }],
    defaults: slots('openai/gpt-oss-20b'),
    extraEnv: { CLAUDE_CODE_ATTRIBUTION_HEADER: '0' },
    listModels: { url: '/v1/models', auth: 'bearer', shape: 'openai' },
    tags: ['local', 'free'],
    notes: [
      'Start the server in LM Studio (Developer → Start server) or run: lms server start --port 1234. Needs LM Studio 0.4.1 or newer.',
      'Load the model with a context length of at least 25K, then enter the same number as the context window in Advanced settings.'
    ]
  },
  {
    id: 'litellm',
    name: 'LiteLLM proxy',
    vendor: 'LiteLLM',
    description: 'Your own LiteLLM gateway (any model LiteLLM supports).',
    kind: 'custom',
    color: '#0EA5A4',
    monogram: 'LL',
    website: 'https://www.litellm.ai',
    docsUrl: 'https://docs.litellm.ai/docs/proxy/client_setup/claude_code',
    regions: [{ id: 'local', label: 'LiteLLM server', baseUrl: 'http://localhost:4000' }],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: false,
    defaultKey: 'none',
    keyPlaceholder: 'LiteLLM master or virtual key',
    models: [],
    defaults: slots(''),
    listModels: { url: '/v1/models', auth: 'bearer', shape: 'openai' },
    tags: [],
    notes: [
      'Enter your LiteLLM address (default http://localhost:4000) and the model_name values from its config.yaml.',
      'Claude Code\'s /model list only shows gateway models whose name contains "claude" or "anthropic"; the models ' +
        'you pick here work either way.'
    ]
  },

  // ───────────────────────────── OpenAI-only providers (translation proxy) ─────────────────────────────
  {
    id: 'openai',
    name: 'OpenAI',
    vendor: 'OpenAI',
    description: 'GPT-6 models through Claude Setup\'s built-in translation proxy.',
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
      { id: 'gpt-6-astra[1m]', label: 'GPT-6 Astra (flagship)', context: 1_050_000, thinking: 'always', vision: true },
      { id: 'gpt-6-luna[1m]', label: 'GPT-6 Luna', context: 1_050_000, thinking: 'always', vision: true, recommendedFor: ['fast'] },
      { id: 'gpt-5.6-sol[1m]', label: 'GPT-5.6 Sol', context: 1_050_000, thinking: 'always', vision: true },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', context: 400_000, thinking: 'always', vision: true }
    ],
    defaults: slots('gpt-6.1-sol[1m]', { haiku: 'gpt-6-luna[1m]', fable: 'gpt-6-astra[1m]' }),
    listModels: { url: '/models', auth: 'bearer', shape: 'openai' },
    tags: ['popular', 'needs-proxy'],
    notes: [
      "OpenAI has no Anthropic-compatible endpoint, so Claude Code talks to Claude Setup's local proxy, which translates every request.",
      'Keep Claude Setup running (it can stay in the tray) while you use Claude Code.'
    ]
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    vendor: 'Google',
    description: "Gemini 4 and 3.8 Flash through Google's OpenAI-compatible API and Claude Setup's proxy.",
    kind: 'openai-proxy',
    color: '#4285F4',
    monogram: 'G',
    website: 'https://aistudio.google.com',
    keyUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    regions: [{ id: 'default', label: 'Gemini API', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' }],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    keyPlaceholder: 'AIza…',
    models: [
      { id: 'gemini-4-argon[1m]', label: 'Gemini 4 Argon', context: M, thinking: 'always', vision: true, recommendedFor: ['main'] },
      { id: 'gemini-3.8-flash[1m]', label: 'Gemini 3.8 Flash', context: M, thinking: 'optional', vision: true, recommendedFor: ['fast'] },
      { id: 'gemini-3.5-flash-lite[1m]', label: 'Gemini 3.5 Flash Lite', context: M, thinking: 'optional', vision: true }
    ],
    defaults: slots('gemini-4-argon[1m]', { haiku: 'gemini-3.8-flash[1m]' }),
    listModels: { url: '/models', auth: 'bearer', shape: 'openai' },
    tags: ['popular', 'long-context', 'needs-proxy'],
    notes: [
      "Gemini's Anthropic-style endpoint doesn't exist, so requests go through Claude Setup's local translation proxy.",
      'Keep Claude Setup running (it can stay in the tray) while you use Claude Code.'
    ]
  },
  {
    id: 'groq',
    name: 'Groq',
    vendor: 'Groq',
    description: 'Very fast open models (gpt-oss, Llama) through Claude Setup\'s proxy.',
    kind: 'openai-proxy',
    color: '#F55036',
    monogram: 'GQ',
    website: 'https://groq.com',
    keyUrl: 'https://console.groq.com/keys',
    docsUrl: 'https://console.groq.com/docs/models',
    regions: [{ id: 'default', label: 'Groq API', baseUrl: 'https://api.groq.com/openai/v1' }],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    keyPlaceholder: 'gsk_…',
    models: [
      { id: 'openai/gpt-oss-120b', label: 'gpt-oss 120B', context: 131072, thinking: 'optional', recommendedFor: ['main'] },
      { id: 'openai/gpt-oss-20b', label: 'gpt-oss 20B', context: 131072, thinking: 'optional', recommendedFor: ['fast'] },
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', context: 131072, thinking: 'none' },
      { id: 'qwen/qwen3.8-27b', label: 'Qwen3.8 27B (preview, 16K output)', context: 131072, thinking: 'optional' }
    ],
    defaults: slots('openai/gpt-oss-120b', { haiku: 'openai/gpt-oss-20b' }),
    contextWindow: 131072,
    listModels: { url: '/models', auth: 'bearer', shape: 'openai' },
    tags: ['fast', 'free', 'needs-proxy'],
    notes: [
      'Groq has a free tier with rate limits. Contexts are 131K, so Claude Code compacts earlier.',
      'Keep Claude Setup running (it can stay in the tray) while you use Claude Code.'
    ]
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    vendor: 'Cerebras',
    description: "Extremely fast inference of open models through Claude Setup's proxy.",
    kind: 'openai-proxy',
    color: '#F05A28',
    monogram: 'CB',
    website: 'https://www.cerebras.ai',
    keyUrl: 'https://cloud.cerebras.ai',
    docsUrl: 'https://inference-docs.cerebras.ai/models/overview',
    regions: [{ id: 'default', label: 'Cerebras API', baseUrl: 'https://api.cerebras.ai/v1' }],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: true,
    keyPlaceholder: 'csk-…',
    models: [
      { id: 'gpt-oss-120b', label: 'gpt-oss 120B', context: 131072, thinking: 'optional', recommendedFor: ['main', 'fast'] },
      { id: 'qwen-3.8-27b', label: 'Qwen 3.8 27B', context: 131072, thinking: 'optional' }
    ],
    defaults: slots('gpt-oss-120b'),
    contextWindow: 65536,
    listModels: { url: '/models', auth: 'bearer', shape: 'openai' },
    tags: ['fast', 'free', 'needs-proxy'],
    notes: [
      'The free tier allows a 64K context (131K on paid plans — raise the context window in Advanced settings).',
      'Keep Claude Setup running (it can stay in the tray) while you use Claude Code.'
    ]
  },
  {
    id: 'openai-compatible',
    name: 'Any OpenAI-compatible server',
    vendor: 'Custom',
    description: 'vLLM, llama.cpp, Together, a company gateway… anything with /v1/chat/completions.',
    kind: 'openai-proxy',
    color: '#64748B',
    monogram: 'CO',
    regions: [{ id: 'custom', label: 'Custom address', baseUrl: '' }],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: false,
    keyPlaceholder: 'API key (if the server needs one)',
    models: [],
    defaults: slots(''),
    listModels: { url: '/models', auth: 'bearer', shape: 'openai' },
    tags: ['needs-proxy'],
    notes: [
      'Enter the server\'s OpenAI base address including /v1, e.g. http://localhost:8000/v1.',
      'Keep Claude Setup running (it can stay in the tray) while you use Claude Code.'
    ]
  },

  // ───────────────────────────── Official clouds (Claude models) ─────────────────────────────
  {
    id: 'bedrock',
    name: 'Amazon Bedrock',
    vendor: 'Amazon Web Services',
    description: "Claude models billed through your AWS account (Claude Code's built-in Bedrock support).",
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
      { id: 'us.anthropic.claude-haiku-5-5', label: 'Claude Haiku 5.5', context: 1_000_000, thinking: 'optional', vision: true, recommendedFor: ['fast'] },
      { id: 'us.anthropic.claude-fable-5-1', label: 'Claude Fable 5.1', context: 1_000_000, thinking: 'optional', vision: true },
      { id: 'us.anthropic.claude-sonnet-4-6', label: 'Claude Sonnet 4.6', thinking: 'optional', vision: true },
      { id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Claude Haiku 4.5', thinking: 'optional', vision: true }
    ],
    defaults: slots('us.anthropic.claude-opus-5-5', {
      sonnet: 'us.anthropic.claude-sonnet-5-5',
      haiku: 'us.anthropic.claude-haiku-5-5',
      fable: 'us.anthropic.claude-fable-5-1',
      subagent: 'us.anthropic.claude-sonnet-5-5'
    }),
    cloudEnv: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' },
    tags: [],
    notes: [
      'Sign in first: aws sso login (set AWS_PROFILE in Advanced), access keys in your environment, or save a Bedrock ' +
        'API key here (AWS_BEARER_TOKEN_BEDROCK).',
      'Model ids depend on the models enabled in your account and region prefix (us., eu., global.) — run ' +
        '/setup-bedrock in Claude Code to check, and edit the ids if needed.'
    ]
  },
  {
    id: 'vertex',
    name: 'Google Cloud Vertex AI',
    vendor: 'Google Cloud',
    description: 'Claude models billed through your Google Cloud project.',
    kind: 'cloud',
    color: '#34A853',
    monogram: 'GV',
    website: 'https://cloud.google.com/vertex-ai',
    docsUrl: 'https://code.claude.com/docs/en/google-vertex-ai',
    regions: [{ id: 'gcp', label: 'Google Cloud', baseUrl: '' }],
    authEnv: 'none',
    requiresKey: false,
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', context: 1_000_000, thinking: 'optional', vision: true, recommendedFor: ['main'] },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', context: 1_000_000, thinking: 'optional', vision: true },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', context: 1_000_000, thinking: 'optional', vision: true, recommendedFor: ['fast'] },
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', context: 1_000_000, thinking: 'optional', vision: true },
      { id: 'claude-haiku-4-5@20251001', label: 'Claude Haiku 4.5', thinking: 'optional', vision: true }
    ],
    defaults: slots('claude-opus-5-5', { sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1', subagent: 'claude-sonnet-5-5' }),
    cloudEnv: { CLAUDE_CODE_USE_VERTEX: '1', CLOUD_ML_REGION: 'global', ANTHROPIC_VERTEX_PROJECT_ID: '<your-gcp-project-id>' },
    tags: [],
    notes: [
      'Run gcloud auth application-default login first, then enter your Google Cloud project id.',
      'Enable the Claude models for your project in the Vertex AI Model Garden.'
    ]
  },
  {
    id: 'foundry',
    name: 'Microsoft Foundry',
    vendor: 'Microsoft Azure',
    description: 'Claude models deployed in your Microsoft Foundry (Azure) resource.',
    kind: 'cloud',
    color: '#0078D4',
    monogram: 'MF',
    website: 'https://ai.azure.com',
    docsUrl: 'https://code.claude.com/docs/en/microsoft-foundry',
    regions: [{ id: 'azure', label: 'Azure', baseUrl: '' }],
    authEnv: 'none',
    requiresKey: false,
    keyPlaceholder: 'Foundry API key (optional)',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (deployment name)', context: 1_000_000, thinking: 'optional', vision: true, recommendedFor: ['main'] },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (deployment name)', context: 1_000_000, thinking: 'optional', vision: true },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (deployment name)', context: 1_000_000, thinking: 'optional', vision: true, recommendedFor: ['fast'] },
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 (deployment name)', context: 1_000_000, thinking: 'optional', vision: true }
    ],
    defaults: slots('claude-opus-5-5', { sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1', subagent: 'claude-sonnet-5-5' }),
    cloudEnv: { CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_RESOURCE: '<your-resource-name>' },
    tags: [],
    notes: [
      'Enter the resource name only (not a URL). Model ids are your deployment names — name deployments after the model id.',
      'Without a saved key Claude Code signs in with your Azure login (az login).'
    ]
  },

  // ───────────────────────────── Custom ─────────────────────────────
  {
    id: 'custom',
    name: 'Custom Anthropic-compatible endpoint',
    vendor: 'Custom',
    description: 'Any server that speaks the Anthropic Messages API (/v1/messages).',
    kind: 'custom',
    color: '#475569',
    monogram: 'CA',
    regions: [{ id: 'custom', label: 'Custom address', baseUrl: '' }],
    authEnv: 'ANTHROPIC_AUTH_TOKEN',
    requiresKey: false,
    defaultKey: 'none',
    keyPlaceholder: 'API key (if the server needs one)',
    models: [],
    defaults: slots(''),
    listModels: { url: '/v1/models', auth: 'bearer', shape: 'anthropic' },
    tags: [],
    notes: ['Enter the base address without /v1 — Claude Code adds /v1/messages itself.']
  }
]

/** Every preset; third-party ones also carry Anthropic's caveat as their last note. */
const PROVIDERS: ProviderPreset[] = PRESET_DATA.map((p) =>
  p.kind === 'anthropic' || p.kind === 'cloud' ? p : { ...p, notes: [...p.notes, ANTHROPIC_CAVEAT] }
)

/** Per-provider settings for the translation proxy upstream (not part of the public preset shape). */
export const PROXY_HINTS: Record<string, Partial<ProxyUpstream>> = {
  openai: { useMaxCompletionTokens: true, reasoning: 'effort', streamOptions: true, maxOutputTokens: 128000 },
  gemini: { reasoning: 'effort', streamOptions: true, maxOutputTokens: 65536 },
  groq: { reasoning: 'off', streamOptions: true, maxOutputTokens: 32768 },
  cerebras: { reasoning: 'off', streamOptions: true, maxOutputTokens: 32768 },
  'openai-compatible': { reasoning: 'off' }
}

/** Where a saved key goes for the official clouds (other clouds sign in with their own CLI). */
export const CLOUD_KEY_ENV: Record<string, string> = {
  bedrock: 'AWS_BEARER_TOKEN_BEDROCK',
  foundry: 'ANTHROPIC_FOUNDRY_API_KEY'
}

/** Model-list ids are prefixed for providers whose Claude Code endpoint expects it (Vercel's /claude-code). */
export const LIST_ID_PREFIX: Record<string, string> = { vercel: 'claude-code/' }

/** Providers whose ids must never get a `[1m]` suffix from listModels. */
export const NO_CONTEXT_SUFFIX = new Set(['siliconflow', 'ollama'])

interface ModelNotice {
  providers: string[]
  pattern: RegExp
  message: (id: string) => string
}

/** Retirements and discontinuations (first match per model wins). */
const MODEL_NOTICES: ModelNotice[] = [
  { providers: ['moonshot'], pattern: /^kimi-k2\.5/i, message: (id) => `${id} was retired by Moonshot on 31 Aug 2026 — switch to Kimi K3.` },
  { providers: ['moonshot'], pattern: /^kimi-k2-/i, message: (id) => `${id} was retired by Moonshot on 25 May 2026 — switch to Kimi K3.` },
  { providers: ['moonshot'], pattern: /^(kimi-latest|moonshot-v1)/i, message: (id) => `${id} has been retired by Moonshot — switch to Kimi K3.` },
  {
    providers: ['moonshot'],
    pattern: /^kimi-k2/i,
    message: (id) =>
      `Moonshot is retiring the Kimi K2 series (${id}): new users lose access from 31 Oct 2026 and the models are switched off by the end of December 2026. Switch to Kimi K3.`
  },
  {
    providers: ['minimax'],
    pattern: /^minimax-m2\.(5|7)/i,
    message: (id) => `${id} closed to new users on 19 Oct 2026 and retires on 18 Nov 2026 — switch to MiniMax-M3.1-Flash.`
  },
  { providers: ['minimax'], pattern: /^minimax-m2(\.1)?$/i, message: (id) => `${id} has been retired by MiniMax — switch to MiniMax-M3.1-Flash.` },
  {
    providers: ['deepseek'],
    pattern: /^deepseek-(chat|reasoner)$/i,
    message: (id) => `${id} was discontinued by DeepSeek on 24 Jul 2026 — use deepseek-flash or deepseek-v4-pro.`
  },
  { providers: ['mimo'], pattern: /^mimo-v2\.5/i, message: (id) => `${id} was deprecated by Xiaomi on 21 Oct 2026 — switch to mimo-v2.6-pro.` }
]

/** Deep copy of every preset (safe to hand out over IPC). */
export function listProviders(): ProviderPreset[] {
  return structuredClone(PROVIDERS)
}

/** Preset by id (shared object — do not mutate). */
export function findProvider(id: string | undefined): ProviderPreset | undefined {
  return id ? PROVIDERS.find((p) => p.id === id) : undefined
}

/** Region by id, else the provider's first region. */
export function findRegion(preset: ProviderPreset, regionId?: string): ProviderRegion | undefined {
  return preset.regions.find((r) => r.id === regionId) ?? preset.regions[0]
}

/** Presets whose address is typed by the user (custom endpoints, any OpenAI-compatible server). */
export function isUserDefinedEndpoint(preset: ProviderPreset): boolean {
  return preset.kind !== 'cloud' && preset.regions.every((r) => !r.baseUrl)
}

/** Identify the provider (and region) behind an ANTHROPIC_BASE_URL (a stray trailing /v1 is tolerated). */
export function providerForBaseUrl(url: string | undefined): { preset: ProviderPreset; region: ProviderRegion } | undefined {
  if (!url?.trim()) return undefined
  const wanted = normalizeBaseUrl(stripTrailingV1(url))
  for (const preset of PROVIDERS) {
    if (preset.kind === 'openai-proxy' || preset.kind === 'cloud') continue
    for (const region of preset.regions) {
      if (region.baseUrl && normalizeBaseUrl(region.baseUrl) === wanted) return { preset, region }
    }
  }
  return undefined
}

/** Retirement/discontinuation warnings for the given model ids of a provider. */
export function modelNotices(providerId: string | undefined, models: Array<string | undefined>): string[] {
  if (!providerId) return []
  const out = new Set<string>()
  for (const raw of models) {
    if (!raw) continue
    const id = stripContextSuffix(raw)
    const notice = MODEL_NOTICES.find((n) => n.providers.includes(providerId) && n.pattern.test(id))
    if (notice) out.add(notice.message(id))
  }
  return [...out]
}

/** Label of a model id from the preset (falls back to the id without its [1m] suffix). */
export function modelLabel(preset: ProviderPreset | undefined, id: string): string {
  const exact = preset?.models.find((m) => m.id === id)
  if (exact) return exact.label
  const loose = preset?.models.find((m) => stripContextSuffix(m.id) === stripContextSuffix(id))
  return loose?.label ?? stripContextSuffix(id)
}
