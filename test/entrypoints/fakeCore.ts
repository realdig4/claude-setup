/**
 * A fake core for entry-point tests: every CoreApi method is a vi.fn() with a sensible default
 * result, plus a real CoreEmitter so event-driven code (proxy logs, catalog progress) can be tested.
 */
import { vi } from 'vitest'
import type { Core } from '@core/index'
import { CoreEmitter } from '@core/events'
import { defaultState } from '@core/state'
import type {
  AppSettings,
  CatalogServer,
  DoctorReport,
  InstallPreview,
  InstallRequest,
  InstallResult,
  InstalledServer,
  ModelProfile,
  ModelStatus,
  ProviderPreset,
  ProxyStatus,
  TargetInfo,
  TestResult
} from '@shared/types'

export const sampleServer: CatalogServer = {
  id: 'io.github.example/github',
  name: 'GitHub',
  slug: 'github',
  description: 'Manage repositories, issues and pull requests.',
  publisher: 'GitHub',
  repository: 'https://github.com/example/github-mcp',
  categories: ['developer-tools'],
  tags: [],
  sources: ['official'],
  official: true,
  verified: true,
  install: [
    {
      id: 'npm',
      kind: 'npm',
      label: 'Run with npx',
      package: '@example/github-mcp',
      runtime: 'node',
      transport: 'stdio',
      env: [{ name: 'GITHUB_TOKEN', required: true, secret: true, description: 'Personal access token' }],
      argsSpec: [{ name: 'path', required: false, repeatable: true }]
    },
    { id: 'remote', kind: 'remote', label: 'Hosted', runtime: 'none', transport: 'http', url: 'https://api.example.com/mcp', env: [], headers: [] }
  ]
}

export const sampleTargets: TargetInfo[] = [
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    description: '',
    installed: true,
    version: '3.6',
    configPath: 'C:/Users/u/AppData/Roaming/Claude/claude_desktop_config.json',
    configExists: true,
    configValid: true,
    supportsRemote: false,
    scopes: [],
    serverCount: 1,
    notes: [],
    primary: true,
    running: false
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    description: '',
    installed: true,
    configPath: 'C:/Users/u/.claude.json',
    configExists: true,
    configValid: true,
    supportsRemote: true,
    scopes: ['user', 'project', 'local'],
    serverCount: 0,
    notes: [],
    primary: true
  },
  {
    id: 'vscode',
    label: 'VS Code',
    description: '',
    installed: false,
    configExists: false,
    configValid: true,
    supportsRemote: true,
    scopes: ['user', 'project'],
    serverCount: 0,
    notes: [],
    primary: false
  }
]

export const sampleInstalled: InstalledServer[] = [
  {
    name: 'github',
    target: { target: 'claude-desktop' },
    config: { type: 'stdio', command: 'npx', args: ['-y', '@example/github-mcp'], env: { GITHUB_TOKEN: 'ghp_secret_value' } },
    enabled: true,
    configPath: 'C:/Users/u/AppData/Roaming/Claude/claude_desktop_config.json',
    managedByUs: true,
    catalogId: 'io.github.example/github'
  },
  {
    name: 'github',
    target: { target: 'claude-code', scope: 'user' },
    config: { type: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer secret' } },
    enabled: true,
    configPath: 'C:/Users/u/.claude.json',
    managedByUs: true
  }
]

export const sampleProvider: ProviderPreset = {
  id: 'kimi',
  name: 'Kimi',
  vendor: 'Moonshot AI',
  description: 'Kimi models',
  kind: 'anthropic-compatible',
  color: '#000000',
  monogram: 'K',
  regions: [
    { id: 'global', label: 'Global', baseUrl: 'https://api.moonshot.ai/anthropic' },
    { id: 'china', label: 'China', baseUrl: 'https://api.moonshot.cn/anthropic' }
  ],
  authEnv: 'ANTHROPIC_AUTH_TOKEN',
  requiresKey: true,
  keyUrl: 'https://platform.moonshot.ai/console/api-keys',
  models: [
    { id: 'kimi-k3', label: 'Kimi K3' },
    { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' }
  ],
  defaults: { main: 'kimi-k3', haiku: 'kimi-k2.7-code', opus: 'kimi-k3' },
  tags: ['popular', 'long-context'],
  notes: []
}

export const sampleProfile: ModelProfile = {
  id: 'kimi-1',
  name: 'Kimi',
  providerId: 'kimi',
  baseUrl: 'https://api.moonshot.ai/anthropic',
  keyRef: 'profile:kimi-1',
  hasKey: true,
  models: { main: 'kimi-k3' },
  compatMode: true,
  extraEnv: {},
  createdAt: '2026-10-23T00:00:00.000Z',
  updatedAt: '2026-10-23T00:00:00.000Z'
}

const okTest: TestResult = { ok: true, ms: 1234, serverName: 'GitHub MCP', serverVersion: '1.0.0', protocol: '2025-11-25', tools: [{ name: 'create_issue' }, { name: 'list_prs' }] }

export function makeFakeCore(overrides: { settings?: Partial<AppSettings> } = {}) {
  const events = new CoreEmitter()
  const state = defaultState()
  state.settings = { ...state.settings, ...overrides.settings }
  const proxyStatus: ProxyStatus = { running: false, requests: 0, errors: 0 }
  const modelStatus: ModelStatus = { mode: 'anthropic', vscodeConfigured: false, vscodeMatches: false, problems: [], shellOverrides: [] }
  const doctorReport: DoctorReport = {
    ranAt: '2026-10-23T00:00:00.000Z',
    checks: [
      { id: 'node', category: 'runtimes', title: 'Node.js 24 found', status: 'ok' },
      { id: 'desktop-json', category: 'claude-desktop', title: 'Config file has an error', status: 'error', detail: 'Unexpected token', fix: { id: 'repair-desktop', label: 'Repair the config file', auto: true } }
    ],
    summary: { ok: 1, warn: 0, error: 1, info: 0, skip: 0 }
  }

  const core = {
    ctx: {
      options: { surface: 'cli', appVersion: '0.1.0' },
      dataDir: 'C:/data',
      cacheDir: 'C:/data/cache',
      events,
      state: { get: () => state, settings: () => state.settings, update: vi.fn() },
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      secrets: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), has: vi.fn(), backend: () => 'memory' },
      backups: { snapshot: vi.fn() }
    },
    app: {
      info: vi.fn(),
      getSettings: vi.fn(async () => state.settings),
      updateSettings: vi.fn(),
      setSecret: vi.fn(),
      hasSecret: vi.fn()
    },
    catalog: {
      search: vi.fn(async () => ({ items: [sampleServer], total: 1, offset: 0, limit: 10 })),
      get: vi.fn(async (id: string) => (id === sampleServer.id ? sampleServer : null)),
      categories: vi.fn(async () => []),
      featured: vi.fn(async () => []),
      stats: vi.fn(),
      refresh: vi.fn(async () => ({
        total: 120,
        refreshing: false,
        sources: [
          { source: 'official' as const, enabled: true, count: 100 },
          { source: 'github' as const, enabled: true, count: 20, error: 'rate limited' }
        ]
      }))
    },
    targets: {
      list: vi.fn(async () => sampleTargets),
      restartDesktop: vi.fn(async () => ({ ok: true, message: 'Claude Desktop was restarted.' })),
      configPath: vi.fn(),
      readRaw: vi.fn()
    },
    servers: {
      list: vi.fn(async (filter?: { target?: string }) => sampleInstalled.filter((s) => !filter?.target || s.target.target === filter.target)),
      preview: vi.fn(
        async (req: InstallRequest): Promise<InstallPreview> => ({
          name: req.name ?? 'github',
          config: req.config ?? { type: 'stdio', command: 'npx', args: ['-y', '@example/github-mcp'] },
          targets: req.targets.map((t) => ({ target: t, configPath: `C:/cfg/${t.target}.json`, snippet: '{ "mcpServers": {} }', supported: true })),
          missingRuntimes: [],
          missingValues: [],
          warnings: []
        })
      ),
      install: vi.fn(
        async (req: InstallRequest): Promise<InstallResult> => ({
          ok: true,
          name: req.name ?? 'github',
          results: req.targets.map((t) => ({
            target: t,
            ok: true,
            message: 'Added.',
            configPath: `C:/cfg/${t.target}.json`,
            backupId: 'b-1',
            needsRestart: t.target === 'claude-desktop',
            written: { env: { SECRET: 'do-not-leak' } }
          })),
          warnings: []
        })
      ),
      uninstall: vi.fn(async (_name: string, targets: Array<{ target: string }>) => targets.map((t) => ({ target: t, ok: true, message: 'Removed.' }))),
      setEnabled: vi.fn(async (_name: string, target: { target: string }, enabled: boolean) => ({ target, ok: true, message: enabled ? 'Enabled.' : 'Disabled.' })),
      update: vi.fn(async (_name: string, target: { target: string }) => ({ target, ok: true, message: 'Updated.' })),
      copy: vi.fn(),
      test: vi.fn(async () => okTest),
      testInstalled: vi.fn(async () => okTest)
    },
    models: {
      providers: vi.fn(async () => [sampleProvider]),
      profiles: vi.fn(async () => [sampleProfile]),
      saveProfile: vi.fn(async () => sampleProfile),
      deleteProfile: vi.fn(async () => ({ ok: true, message: 'Deleted.' })),
      status: vi.fn(async () => modelStatus),
      apply: vi.fn(async (req: { targets: string[] }) => ({ ok: true, results: req.targets.map((t) => ({ target: t, ok: true, message: 'Configured.' })), warnings: [] })),
      reset: vi.fn(async (targets: string[]) => ({ ok: true, results: targets.map((t) => ({ target: t, ok: true, message: 'Reset.' })), warnings: [] })),
      listModels: vi.fn(async () => []),
      testConnection: vi.fn(async () => ({ ok: true, ms: 321, verdict: 'ok' as const, message: 'The connection works.' }))
    },
    proxy: {
      status: vi.fn(async () => proxyStatus),
      start: vi.fn(async () => ({ ...proxyStatus, running: true, port: 3460, url: 'http://127.0.0.1:3460' })),
      stop: vi.fn(async () => proxyStatus),
      getConfig: vi.fn(),
      saveConfig: vi.fn(),
      logs: vi.fn(async () => [])
    },
    extensions: {
      search: vi.fn(async () => [
        { id: 'plugin:x@official', kind: 'plugin' as const, name: 'x', description: 'An example plugin', source: 'marketplace' as const, installed: false }
      ]),
      installed: vi.fn(async () => []),
      install: vi.fn(async () => ({ ok: true, message: 'Installed.' })),
      uninstall: vi.fn(async () => ({ ok: true, message: 'Removed.' })),
      setEnabled: vi.fn(),
      marketplaces: vi.fn(),
      addMarketplace: vi.fn(),
      removeMarketplace: vi.fn(),
      claudeMdTemplates: vi.fn(),
      writeClaudeMd: vi.fn()
    },
    doctor: {
      run: vi.fn(async () => doctorReport),
      fix: vi.fn(async () => ({ ok: true, message: 'Repaired.', backupId: 'b-2' }))
    },
    backups: {
      list: vi.fn(async () => [
        { id: '20261023-120000-abcd', createdAt: '2026-10-23T12:00:00.000Z', reason: 'Install github', files: [{ path: 'C:/cfg/a.json', existed: true, size: 10 }] }
      ]),
      restore: vi.fn(async () => ({ ok: true, message: 'Restored.' })),
      delete: vi.fn()
    },
    runtimes: { detect: vi.fn(), install: vi.fn() },
    self: {
      mcpStatus: vi.fn(async () => [
        { target: 'claude-desktop' as const, registered: false },
        { target: 'claude-code' as const, registered: true, configPath: 'C:/Users/u/.claude.json' }
      ]),
      registerMcp: vi.fn(async (targets: Array<{ target: string }>) => ({ ok: true, name: 'claude-setup', results: targets.map((t) => ({ target: t, ok: true, message: 'Added.' })), warnings: [] })),
      unregisterMcp: vi.fn(async () => []),
      installCli: vi.fn()
    },
    dispose: vi.fn(async () => {})
  }
  return core as typeof core & Core
}

export type FakeCore = ReturnType<typeof makeFakeCore>
