/**
 * The single API contract shared by every surface:
 *   - Electron renderer  → calls it over IPC (window.api.call)
 *   - CLI                → calls the core directly
 *   - MCP server         → calls the core directly
 *
 * Every method must be JSON-serializable in/out (it crosses IPC).
 */
import type {
  AppInfo,
  AppSettings,
  ApplyModelRequest,
  ApplyModelResult,
  BackupEntry,
  CatalogPage,
  CatalogQuery,
  CatalogServer,
  CatalogStats,
  CategoryInfo,
  ClaudeMdTemplate,
  ConnectionTestInput,
  ConnectionTestResult,
  DoctorReport,
  ExtensionItem,
  ExtensionKind,
  ExtensionQuery,
  InstallPreview,
  InstallRequest,
  InstallResult,
  InstalledServer,
  LogEvent,
  Marketplace,
  ModelPreset,
  ModelProfile,
  ModelProfileInput,
  ModelStatus,
  ModelTarget,
  OpResult,
  ProviderPreset,
  ProxyConfig,
  ProxyLogEntry,
  ProxyStatus,
  RuntimeInfo,
  RuntimeName,
  Scope,
  ServerConfig,
  TargetChangeResult,
  TargetId,
  TargetInfo,
  TargetRef,
  TestResult
} from './types'

export interface AppApi {
  info(): Promise<AppInfo>
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  /** Store/remove a named secret (API keys, tokens). Value never returned to the renderer. */
  setSecret(ref: string, value: string | null): Promise<OpResult>
  hasSecret(ref: string): Promise<boolean>
}

export interface CatalogApi {
  search(query: CatalogQuery): Promise<CatalogPage>
  get(id: string): Promise<CatalogServer | null>
  categories(): Promise<CategoryInfo[]>
  /** Curated, beginner-friendly picks (works offline). */
  featured(): Promise<CatalogServer[]>
  stats(): Promise<CatalogStats>
  /** Re-fetch sources. `force` ignores the TTL. Emits 'catalog' events while running. */
  refresh(opts?: { force?: boolean }): Promise<CatalogStats>
}

export interface TargetsApi {
  list(): Promise<TargetInfo[]>
  /** Quit and relaunch Claude Desktop so it reloads its config. */
  restartDesktop(): Promise<OpResult>
  /** Open the target's config file location in the OS file manager (GUI) / return path. */
  configPath(ref: TargetRef): Promise<string | null>
  /** Raw config text for the Advanced "view config" panel. */
  readRaw(ref: TargetRef): Promise<{ path: string; exists: boolean; text: string } | null>
}

export interface ServersApi {
  list(filter?: { target?: TargetId; scope?: Scope; projectPath?: string }): Promise<InstalledServer[]>
  preview(req: InstallRequest): Promise<InstallPreview>
  install(req: InstallRequest): Promise<InstallResult>
  uninstall(name: string, targets: TargetRef[]): Promise<TargetChangeResult[]>
  setEnabled(name: string, target: TargetRef, enabled: boolean): Promise<TargetChangeResult>
  update(name: string, target: TargetRef, config: ServerConfig): Promise<TargetChangeResult>
  /** Copy an installed server to other targets. */
  copy(name: string, from: TargetRef, to: TargetRef[]): Promise<InstallResult>
  test(config: ServerConfig, opts?: { timeoutMs?: number }): Promise<TestResult>
  testInstalled(name: string, target: TargetRef): Promise<TestResult>
}

export interface ModelsApi {
  providers(): Promise<ProviderPreset[]>
  profiles(): Promise<ModelProfile[]>
  saveProfile(input: ModelProfileInput): Promise<ModelProfile>
  deleteProfile(id: string): Promise<OpResult>
  status(): Promise<ModelStatus>
  apply(req: ApplyModelRequest): Promise<ApplyModelResult>
  /** Remove every third-party model setting → back to official Claude. */
  reset(targets: ModelTarget[]): Promise<ApplyModelResult>
  listModels(input: ConnectionTestInput): Promise<ModelPreset[]>
  testConnection(input: ConnectionTestInput): Promise<ConnectionTestResult>
}

export interface ProxyApi {
  status(): Promise<ProxyStatus>
  start(): Promise<ProxyStatus>
  stop(): Promise<ProxyStatus>
  getConfig(): Promise<ProxyConfig>
  saveConfig(config: ProxyConfig): Promise<ProxyConfig>
  logs(limit?: number): Promise<ProxyLogEntry[]>
}

export interface ExtensionsApi {
  search(query: ExtensionQuery): Promise<ExtensionItem[]>
  installed(kind?: ExtensionKind): Promise<ExtensionItem[]>
  install(id: string, opts?: { scope?: Scope; projectPath?: string }): Promise<OpResult>
  uninstall(id: string, opts?: { scope?: Scope; projectPath?: string }): Promise<OpResult>
  setEnabled(id: string, enabled: boolean): Promise<OpResult>
  marketplaces(): Promise<Marketplace[]>
  addMarketplace(source: string): Promise<OpResult>
  removeMarketplace(name: string): Promise<OpResult>
  /** Drop cached catalogs so the next search re-fetches every source. */
  refresh(): Promise<OpResult>
  claudeMdTemplates(): Promise<ClaudeMdTemplate[]>
  /** Write CLAUDE.md for the user (~/.claude/CLAUDE.md) or a project. Appends unless replace. */
  writeClaudeMd(templateId: string, where: { scope: 'user' } | { scope: 'project'; projectPath: string }, replace?: boolean): Promise<OpResult>
}

export interface DoctorApi {
  run(): Promise<DoctorReport>
  fix(fixId: string): Promise<OpResult>
}

export interface BackupsApi {
  list(): Promise<BackupEntry[]>
  restore(id: string): Promise<OpResult>
  delete(id: string): Promise<OpResult>
}

export interface RuntimesApi {
  detect(): Promise<RuntimeInfo[]>
  /** Install via winget/brew/official script when possible. */
  install(id: RuntimeName): Promise<OpResult>
}

export interface SelfApi {
  /** Whether Claude Setup's own MCP server is registered in each target. */
  mcpStatus(): Promise<Array<{ target: TargetId; registered: boolean; configPath?: string }>>
  /** Register Claude Setup as an MCP server so Claude can manage its own setup. */
  registerMcp(targets: TargetRef[]): Promise<InstallResult>
  unregisterMcp(targets: TargetRef[]): Promise<TargetChangeResult[]>
  /** Put a `claude-setup` command on the user's PATH (~/.local/bin shim). */
  installCli(): Promise<OpResult>
}

export interface CoreApi {
  app: AppApi
  catalog: CatalogApi
  targets: TargetsApi
  servers: ServersApi
  models: ModelsApi
  proxy: ProxyApi
  extensions: ExtensionsApi
  doctor: DoctorApi
  backups: BackupsApi
  runtimes: RuntimesApi
  self: SelfApi
}

/** Events pushed from the core (and forwarded to the renderer as 'core:event'). */
export interface CoreEvents {
  log: LogEvent
  catalog: { phase: 'start' | 'source' | 'done' | 'error'; source?: string; count?: number; message?: string }
  progress: { op: string; message: string; pct?: number }
  proxy: ProxyLogEntry
  state: { key: string }
  /** GUI only: window maximized/restored (sent by the Electron main process). */
  window: { maximized: boolean }
}

export type CoreEventName = keyof CoreEvents
export type CoreEvent = { [K in CoreEventName]: { name: K; payload: CoreEvents[K] } }[CoreEventName]

/** GUI-only helpers implemented by the Electron main process (not the core). */
export interface UiApi {
  openExternal(url: string): Promise<void>
  showItemInFolder(path: string): Promise<void>
  openPath(path: string): Promise<string>
  pickFolder(opts?: { title?: string; defaultPath?: string }): Promise<string | null>
  pickFile(opts?: { title?: string; filters?: Array<{ name: string; extensions: string[] }> }): Promise<string | null>
  copyText(text: string): Promise<void>
  readClipboard(): Promise<string>
  window(action: 'minimize' | 'maximize' | 'close'): Promise<void>
  windowState(): Promise<{ maximized: boolean }>
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC plumbing (generic dispatcher; channel names are fixed)
// ─────────────────────────────────────────────────────────────────────────────

export const IPC = {
  core: 'core:call',
  ui: 'ui:call',
  event: 'core:event'
} as const

export type Namespace = keyof CoreApi
export type MethodOf<N extends Namespace> = keyof CoreApi[N] & string
type Fn = (...args: never[]) => unknown
export type ArgsOf<N extends Namespace, M extends MethodOf<N>> = CoreApi[N][M] extends Fn
  ? Parameters<CoreApi[N][M]>
  : never
export type ResultOf<N extends Namespace, M extends MethodOf<N>> = CoreApi[N][M] extends Fn
  ? Awaited<ReturnType<CoreApi[N][M]>>
  : never

/** Allow-list of callable core methods (validated in the main process). */
export const CORE_METHODS: { [N in Namespace]: ReadonlyArray<MethodOf<N>> } = {
  app: ['info', 'getSettings', 'updateSettings', 'setSecret', 'hasSecret'],
  catalog: ['search', 'get', 'categories', 'featured', 'stats', 'refresh'],
  targets: ['list', 'restartDesktop', 'configPath', 'readRaw'],
  servers: ['list', 'preview', 'install', 'uninstall', 'setEnabled', 'update', 'copy', 'test', 'testInstalled'],
  models: ['providers', 'profiles', 'saveProfile', 'deleteProfile', 'status', 'apply', 'reset', 'listModels', 'testConnection'],
  proxy: ['status', 'start', 'stop', 'getConfig', 'saveConfig', 'logs'],
  extensions: [
    'search',
    'installed',
    'install',
    'uninstall',
    'setEnabled',
    'marketplaces',
    'addMarketplace',
    'removeMarketplace',
    'refresh',
    'claudeMdTemplates',
    'writeClaudeMd'
  ],
  doctor: ['run', 'fix'],
  backups: ['list', 'restore', 'delete'],
  runtimes: ['detect', 'install'],
  self: ['mcpStatus', 'registerMcp', 'unregisterMcp', 'installCli']
}

export const UI_METHODS: ReadonlyArray<keyof UiApi> = [
  'openExternal',
  'showItemInFolder',
  'openPath',
  'pickFolder',
  'pickFile',
  'copyText',
  'readClipboard',
  'window',
  'windowState'
]

/** Shape exposed on window.api by the preload script. */
export interface PreloadApi {
  call<N extends Namespace, M extends MethodOf<N>>(ns: N, method: M, ...args: ArgsOf<N, M>): Promise<ResultOf<N, M>>
  ui<M extends keyof UiApi>(method: M, ...args: Parameters<UiApi[M]>): ReturnType<UiApi[M]>
  onEvent(cb: (event: CoreEvent) => void): () => void
  platform: 'win32' | 'darwin' | 'linux'
}
