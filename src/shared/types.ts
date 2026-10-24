/**
 * Shared domain types. Pure types only — imported by the core (Node), the
 * Electron main/preload, the CLI, the MCP server AND the renderer (browser).
 * Never import Node or Electron modules here.
 */

export type OS = 'win32' | 'darwin' | 'linux'

// ─────────────────────────────────────────────────────────────────────────────
// MCP server launch configuration (normalized, client-agnostic)
// ─────────────────────────────────────────────────────────────────────────────

export interface StdioServerConfig {
  type: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  /** Not supported by Claude Desktop (stripped on rewrite); honoured by Claude Code. */
  cwd?: string
}

export interface RemoteServerConfig {
  type: 'http' | 'sse'
  url: string
  headers?: Record<string, string>
}

export type ServerConfig = StdioServerConfig | RemoteServerConfig

// ─────────────────────────────────────────────────────────────────────────────
// Catalog (aggregated from public MCP registries)
// ─────────────────────────────────────────────────────────────────────────────

export type CatalogSource =
  | 'official' // registry.modelcontextprotocol.io (~49k servers, CC0)
  | 'anthropic' // Anthropic sub-registry = Claude Connectors Directory (curated remotes)
  | 'github' // GitHub MCP Registry (api.mcp.github.com, curated + stars)
  | 'smithery' // registry.smithery.ai (~20k, hosted remotes / mcpb)
  | 'docker' // Docker MCP catalog (catalog.yaml)
  | 'cline' // Cline marketplace (stars/downloads)
  | 'awesome' // punkpeye/awesome-mcp-servers README (discovery only)
  | 'glama' // needs API key (optional)
  | 'pulsemcp' // needs partner API key (optional)
  | 'seed' // curated list bundled with the app (works offline)

export interface EnvVarSpec {
  name: string
  description?: string
  required: boolean
  secret: boolean
  default?: string
  placeholder?: string
  format?: 'string' | 'path' | 'directory' | 'url' | 'number' | 'boolean'
  /** Where the user can obtain the value (e.g. token settings page). */
  helpUrl?: string
  /** Value template, e.g. "Bearer {{value}}" — the user types only the token. */
  template?: string
  /** Allowed values (shown as a select). */
  choices?: string[]
}

export interface ArgSpec {
  name: string
  description?: string
  required: boolean
  /** e.g. several allowed directories for the filesystem server */
  repeatable?: boolean
  format?: 'string' | 'path' | 'directory' | 'url' | 'number'
  default?: string
  secret?: boolean
  choices?: string[]
}

export type InstallKind = 'npm' | 'pypi' | 'docker' | 'remote' | 'binary' | 'mcpb' | 'nuget' | 'manual'
export type RuntimeId = 'node' | 'uv' | 'python' | 'docker' | 'dotnet' | 'none'

export interface InstallOption {
  /** Unique within the server, e.g. "npm", "remote", "docker". */
  id: string
  kind: InstallKind
  label: string
  /** Package identifier (npm/pypi/docker image/nuget id). */
  package?: string
  version?: string
  runtime: RuntimeId
  transport: 'stdio' | 'http' | 'sse'
  /** Remote endpoint for kind === 'remote'. */
  url?: string
  /**
   * Explicit launch template (overrides the default derived from kind/package).
   * Strings may contain placeholders: {{ENV_NAME}} or {{arg:NAME}}.
   */
  command?: string
  args?: string[]
  env: EnvVarSpec[]
  headers?: EnvVarSpec[]
  argsSpec?: ArgSpec[]
  notes?: string
  /** Checksum of an .mcpb bundle (computed and pinned on first download). */
  sha256?: string
  /** Runtime version requirement, e.g. ">=24". */
  runtimeVersion?: string
}

export interface CatalogServer {
  /** Stable dedupe key, e.g. "io.github.modelcontextprotocol/filesystem". */
  id: string
  /** Display name, e.g. "Filesystem". */
  name: string
  /** Suggested config key: [A-Za-z0-9_-], e.g. "filesystem". */
  slug: string
  description: string
  /** Optional longer description / README excerpt (markdown). */
  longDescription?: string
  publisher?: string
  repository?: string
  homepage?: string
  iconUrl?: string
  categories: string[]
  tags: string[]
  sources: CatalogSource[]
  /** Published by the vendor of the integrated product (e.g. GitHub's own server). */
  official?: boolean
  /** Curated / registry-validated. */
  verified?: boolean
  /** 0..100 normalized popularity used for ranking. */
  popularity?: number
  stars?: number
  updatedAt?: string
  version?: string
  /** Deprecated by its publisher (true or a reason). */
  deprecated?: string | boolean
  install: InstallOption[]
}

export interface CatalogQuery {
  query?: string
  category?: string
  source?: CatalogSource
  /** Only servers with at least one remote (no local runtime needed) option. */
  remoteOnly?: boolean
  /** Only servers that do not require any secret/API key. */
  noKeyRequired?: boolean
  sort?: 'relevance' | 'popular' | 'name' | 'updated'
  offset?: number
  limit?: number
}

export interface CatalogPage {
  items: CatalogServer[]
  total: number
  offset: number
  limit: number
}

export interface CatalogSourceStatus {
  source: CatalogSource
  enabled: boolean
  count: number
  lastFetched?: string
  error?: string
}

export interface CatalogStats {
  total: number
  sources: CatalogSourceStatus[]
  lastRefreshed?: string
  refreshing: boolean
}

export interface CategoryInfo {
  id: string
  label: string
  count: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Targets (apps that consume MCP servers)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * - claude-desktop: Claude Desktop app (claude_desktop_config.json)
 * - claude-code:    Claude Code CLI — also used by the Claude Code VS Code &
 *                   JetBrains extensions (~/.claude.json, .mcp.json)
 * - vscode:         VS Code's own MCP support (Copilot agent mode, mcp.json)
 * - cursor, windsurf: other popular MCP hosts
 */
export type TargetId = 'claude-desktop' | 'claude-code' | 'vscode' | 'cursor' | 'windsurf'

/** Only meaningful for claude-code (and vscode: user|project). */
export type Scope = 'user' | 'project' | 'local'

export interface TargetRef {
  target: TargetId
  scope?: Scope
  /** Required when scope is 'project' or 'local'. Absolute path. */
  projectPath?: string
}

export interface TargetInfo {
  id: TargetId
  label: string
  description: string
  /** App/CLI detected on this machine. */
  installed: boolean
  version?: string
  /** Primary config file for user scope (resolved physical path). */
  configPath?: string
  configExists: boolean
  /** Config currently parses fine. */
  configValid: boolean
  configError?: string
  /** For claude-desktop: app process running (changes need a restart). */
  running?: boolean
  /** Native support for http/sse servers in config. */
  supportsRemote: boolean
  scopes: Scope[]
  serverCount: number
  notes: string[]
  /** Primary target shown in Simple mode. */
  primary: boolean
}

export interface InstalledServer {
  name: string
  target: TargetRef
  config: ServerConfig
  enabled: boolean
  configPath: string
  /** Set when installed through Claude Setup. */
  catalogId?: string
  managedByUs: boolean
  installedAt?: string
}

export interface InstallValues {
  env?: Record<string, string>
  headers?: Record<string, string>
  /** Values for ArgSpec entries, by arg name. Repeatable args use string[]. */
  args?: Record<string, string | string[]>
  /** Extra raw args appended to the command. */
  extraArgs?: string[]
}

export interface InstallRequest {
  /** Install from the catalog... */
  catalogId?: string
  optionId?: string
  values?: InstallValues
  /** ...or install a custom/raw configuration. */
  config?: ServerConfig
  /** Config key; defaults to the catalog slug. [A-Za-z0-9_-] */
  name?: string
  targets: TargetRef[]
  /** Replace an existing server with the same name. */
  overwrite?: boolean
  /** Run a connection test after installing (default false). */
  test?: boolean
}

export interface TargetChangeResult {
  target: TargetRef
  ok: boolean
  message: string
  configPath?: string
  backupId?: string
  /** e.g. Claude Desktop must be restarted to pick up changes. */
  needsRestart?: boolean
  /** The exact entry written (as stored in that target's format). */
  written?: unknown
  /** Machine-readable failure reason so the UI can offer e.g. "Replace". */
  code?: 'exists' | 'not-found' | 'invalid-file' | 'blocked' | 'backup-failed' | 'write-failed' | 'unsupported' | 'conflict'
}

export interface InstallResult {
  ok: boolean
  name: string
  results: TargetChangeResult[]
  test?: TestResult
  warnings: string[]
}

export interface InstallPreview {
  name: string
  config: ServerConfig
  targets: Array<{
    target: TargetRef
    configPath?: string
    /** Pretty JSON snippet of what will be written. */
    snippet: string
    supported: boolean
    note?: string
  }>
  missingRuntimes: RuntimeInfo[]
  missingValues: string[]
  warnings: string[]
}

export type TestFailureKind =
  | 'auth-required'
  | 'timeout'
  | 'process-exited'
  | 'command-not-found'
  | 'sse-failed'
  | 'invalid-config'
  | 'error'

export interface TestResult {
  ok: boolean
  kind?: TestFailureKind
  ms: number
  serverName?: string
  serverVersion?: string
  protocol?: string
  instructions?: string
  tools: Array<{ name: string; title?: string; description?: string }>
  stderr?: string
  error?: string
  /** Friendly next step, e.g. "Set GITHUB_TOKEN" or "Start Docker Desktop". */
  hint?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Models / providers
// ─────────────────────────────────────────────────────────────────────────────

export type ModelSlot = 'main' | 'opus' | 'sonnet' | 'haiku' | 'fable' | 'subagent'

export interface ModelPreset {
  id: string
  label: string
  /** Context window in tokens (when known). */
  context?: number
  thinking?: 'optional' | 'always' | 'none'
  vision?: boolean
  notes?: string
  /** Which slots it is a good default for. */
  recommendedFor?: Array<'main' | 'fast'>
}

export type ProviderKind =
  /** Anthropic itself (default Claude Code behaviour, nothing to set). */
  | 'anthropic'
  /** Third party that speaks the Anthropic Messages API natively. */
  | 'anthropic-compatible'
  /** OpenAI-compatible only → routed through the built-in translation proxy. */
  | 'openai-proxy'
  /** Local servers (Ollama, LM Studio) — Anthropic-compatible on localhost. */
  | 'local'
  /** Bedrock / Vertex / Foundry via CLAUDE_CODE_USE_* (Claude models). */
  | 'cloud'
  /** User-defined endpoint. */
  | 'custom'

export interface ProviderRegion {
  id: string
  label: string
  /** ANTHROPIC_BASE_URL (no trailing /v1), or OpenAI base (with /v1) for openai-proxy. */
  baseUrl: string
}

export interface ProviderPreset {
  id: string
  name: string
  vendor: string
  description: string
  kind: ProviderKind
  /** Brand color (hex) + short monogram for the UI avatar. No logos are bundled. */
  color: string
  monogram: string
  website?: string
  keyUrl?: string
  docsUrl?: string
  regions: ProviderRegion[]
  authEnv: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY' | 'none'
  /** Also write ANTHROPIC_API_KEY="" (OpenRouter, Vercel, Ollama). */
  blankApiKey?: boolean
  requiresKey: boolean
  /** Fixed key for local servers, e.g. "ollama". */
  defaultKey?: string
  keyPlaceholder?: string
  models: ModelPreset[]
  defaults: Partial<Record<ModelSlot, string>> & { main: string }
  /** Extra env always written for this provider (strings only). */
  extraEnv?: Record<string, string>
  /** Extra top-level settings.json keys (e.g. skipWebFetchPreflight). */
  extraSettings?: Record<string, unknown>
  /** Recommended context window in tokens for CLAUDE_CODE_AUTO_COMPACT_WINDOW. */
  contextWindow?: number
  listModels?: {
    /** Absolute URL, a path appended to the region baseUrl when it starts with '/', or '{origin}/…' (origin of the region baseUrl). */
    url: string
    auth: 'bearer' | 'x-api-key' | 'none'
    shape: 'openai' | 'anthropic' | 'ollama'
  }
  tags: Array<'popular' | 'cheap' | 'fast' | 'long-context' | 'free' | 'local' | 'coding-plan' | 'china' | 'needs-proxy'>
  notes: string[]
  /** Only for kind === 'cloud'. */
  cloudEnv?: Record<string, string>
}

export interface ModelProfile {
  id: string
  name: string
  providerId: string
  regionId?: string
  /** Effective base URL (Anthropic-compatible URL; for openai-proxy the upstream OpenAI base). */
  baseUrl: string
  /** Secret store key holding the API key (never the key itself). */
  keyRef?: string
  hasKey: boolean
  models: Partial<Record<ModelSlot, string>> & { main: string }
  /** Write the compatibility env bundle (tool search off, betas off, …). */
  compatMode: boolean
  /** Extra env vars (strings). */
  extraEnv: Record<string, string>
  /** Tokens; written as CLAUDE_CODE_AUTO_COMPACT_WINDOW / MAX_CONTEXT_TOKENS when set. */
  contextWindow?: number
  /** Keep keys out of settings.json using apiKeyHelper → `claude-setup secret get`. */
  useKeyHelper?: boolean
  createdAt: string
  updatedAt: string
}

export interface ModelProfileInput {
  id?: string
  name: string
  providerId: string
  regionId?: string
  baseUrl?: string
  /** Plain API key (stored in the secret store, never persisted in state). */
  apiKey?: string
  models: Partial<Record<ModelSlot, string>> & { main: string }
  compatMode?: boolean
  extraEnv?: Record<string, string>
  contextWindow?: number
  useKeyHelper?: boolean
}

export type ModelTarget = 'claude-code' | 'vscode'

export interface ModelStatus {
  /** What Claude Code currently uses according to ~/.claude/settings.json env. */
  mode: 'anthropic' | 'custom' | 'cloud'
  profileId?: string
  providerId?: string
  providerName?: string
  baseUrl?: string
  model?: string
  authVar?: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY' | 'apiKeyHelper'
  /** Same configuration also present in VS Code claudeCode.environmentVariables. */
  vscodeConfigured: boolean
  vscodeMatches: boolean
  /** Human-readable problems: auth conflicts, missing slots, shell overrides... */
  problems: string[]
  /** ANTHROPIC_* variables present in the process/shell environment. */
  shellOverrides: string[]
}

export interface ApplyModelRequest {
  profileId: string
  targets: ModelTarget[]
}

export interface ApplyModelResult {
  ok: boolean
  results: Array<{ target: ModelTarget; ok: boolean; message: string; configPath?: string; backupId?: string }>
  warnings: string[]
  /** e.g. proxy started for openai-proxy providers. */
  proxyStarted?: boolean
}

export interface ConnectionTestInput {
  profileId?: string
  providerId?: string
  regionId?: string
  baseUrl?: string
  apiKey?: string
  model?: string
}

export interface ConnectionTestResult {
  ok: boolean
  status?: number
  ms: number
  /** 'ok' | 'bad-key' | 'bad-model' | 'bad-url' | 'quota' | 'network' | 'unknown' */
  verdict: 'ok' | 'bad-key' | 'bad-model' | 'bad-url' | 'quota' | 'network' | 'unknown'
  message: string
  sample?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Translation proxy (Anthropic Messages ⇄ OpenAI Chat Completions)
// ─────────────────────────────────────────────────────────────────────────────

export interface ProxyUpstream {
  id: string
  name: string
  providerId?: string
  /** OpenAI-compatible base INCLUDING /v1, e.g. https://api.openai.com/v1 */
  baseUrl: string
  /** Secret store key for the upstream API key. */
  keyRef?: string
  models: string[]
  maxOutputTokens?: number
  /** How to treat reasoning: drop, map effort, round-trip reasoning_content, or both. */
  reasoning?: 'off' | 'effort' | 'roundtrip' | 'both'
  useMaxCompletionTokens?: boolean
  streamOptions?: boolean
  extraHeaders?: Record<string, string>
  /** reasoning_effort sent for Anthropic 'xhigh'/'max' effort (default 'high'). */
  maxEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Extra top-level fields merged into every upstream payload (model/messages/stream protected). */
  extraBody?: Record<string, unknown>
}

export interface ProxyConfig {
  port: number
  /** Token Claude Code must send (ANTHROPIC_AUTH_TOKEN). */
  authToken: string
  upstreams: ProxyUpstream[]
  /** Model alias → "upstreamId/model". Unknown names fall back to defaultRoute. */
  routes: Record<string, string>
  defaultRoute?: string
  /** Route used for haiku/background requests. */
  smallRoute?: string
  autoStart: boolean
}

export interface ProxyStatus {
  running: boolean
  port?: number
  url?: string
  startedAt?: string
  requests: number
  errors: number
  lastError?: string
  /** Running in another process (e.g. started from the CLI). */
  external?: boolean
}

export interface ProxyLogEntry {
  time: string
  level: 'info' | 'warn' | 'error'
  message: string
  model?: string
  upstream?: string
  status?: number
  ms?: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude Code extensions: plugins, skills, agents, commands, hooks…
// ─────────────────────────────────────────────────────────────────────────────

export type ExtensionKind =
  | 'plugin'
  | 'skill'
  | 'agent'
  | 'command'
  | 'hook'
  | 'statusline'
  | 'output-style'

export type ExtensionSource =
  | 'claude-cli' // `claude plugin list --json --available`
  | 'marketplace' // raw marketplace.json from GitHub
  | 'skills.sh'
  | 'aitmpl'
  | 'anthropic-skills'
  | 'local'

export interface ExtensionItem {
  /** "plugin:<name>@<marketplace>", "<kind>:<source>:<owner>/<repo>/<path>" (catalog), or "<kind>:local:<user|project|local>[:<encodeURIComponent(projectPath)>]:<key>" (installed, from installed()). */
  id: string
  kind: ExtensionKind
  name: string
  description: string
  author?: string
  source: ExtensionSource
  marketplace?: string
  /** GitHub "owner/repo" when known. */
  repo?: string
  /** Path inside the repo (skill dir, agent .md, …). */
  path?: string
  url?: string
  category?: string
  installs?: number
  stars?: number
  installed: boolean
  /** Where it is installed (file or directory) when installed. */
  installedPath?: string
  scope?: Scope
  enabled?: boolean
  /** Security score/flags when the source provides them. */
  warnings?: string[]
}

export interface ExtensionQuery {
  kind?: ExtensionKind
  query?: string
  source?: ExtensionSource
  limit?: number
}

export interface Marketplace {
  name: string
  source: string
  repo?: string
  pluginCount?: number
  added: boolean
  official?: boolean
  description?: string
}

export interface ClaudeMdTemplate {
  id: string
  name: string
  description: string
  content: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Doctor / runtimes / backups / generic results
// ─────────────────────────────────────────────────────────────────────────────

export type RuntimeName = 'node' | 'npx' | 'uv' | 'uvx' | 'python' | 'docker' | 'git' | 'claude' | 'code' | 'winget' | 'brew'

export interface RuntimeInfo {
  id: RuntimeName
  label: string
  found: boolean
  version?: string
  path?: string
  /** docker: daemon running */
  running?: boolean
  /** Below the minimum supported version (e.g. node < 20). */
  outdated?: boolean
  purpose: string
  install?: {
    /** One-line command for this OS (winget/brew/script), when available. */
    command?: string
    url: string
    canAutoInstall: boolean
  }
}

export type CheckStatus = 'ok' | 'warn' | 'error' | 'info' | 'skip'

export interface DoctorCheck {
  id: string
  category: 'runtimes' | 'claude-desktop' | 'claude-code' | 'vscode' | 'models' | 'mcp' | 'system'
  title: string
  status: CheckStatus
  detail?: string
  fix?: { id: string; label: string; auto: boolean }
  docsUrl?: string
}

export interface DoctorReport {
  ranAt: string
  checks: DoctorCheck[]
  summary: Record<CheckStatus, number>
}

export interface BackupEntry {
  id: string
  createdAt: string
  reason: string
  files: Array<{ path: string; existed: boolean; size: number }>
}

export interface OpResult {
  ok: boolean
  message: string
  details?: string
  backupId?: string
  needsRestart?: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// App state & settings
// ─────────────────────────────────────────────────────────────────────────────

export interface AppSettings {
  mode: 'simple' | 'advanced'
  theme: 'system' | 'light' | 'dark'
  /** Targets pre-selected in the install wizard. */
  defaultTargets: TargetRef[]
  sources: Record<CatalogSource, boolean>
  /** Hours before the catalog cache is considered stale. */
  catalogTtlHours: number
  /** Secret store key for an optional Smithery API key. */
  smitheryKeyRef?: string
  /** Secret store keys for optional Glama / PulseMCP API keys (enable those sources). */
  glamaKeyRef?: string
  pulsemcpKeyRef?: string
  pulsemcpTenantId?: string
  /** Secret store key for an optional GitHub token (raises API rate limits). */
  githubTokenRef?: string
  /** Restart Claude Desktop automatically after changes (asks otherwise). */
  autoRestartDesktop: boolean
  /** Number of backups to keep. */
  keepBackups: number
  onboarded: boolean
  /** Recent project folders used for project/local scopes. */
  recentProjects: string[]
  /** Start Claude Setup hidden in the tray when the user logs in (keeps the proxy available). */
  startAtLogin?: boolean
}

export interface InstallRecord {
  name: string
  catalogId?: string
  optionId?: string
  target: TargetRef
  installedAt: string
}

/** Servers removed from a config to "disable" them (Claude Desktop has no disabled flag). */
export interface DisabledServerRecord {
  name: string
  target: TargetRef
  /** Redacted copy (secret values blanked) when secretRef is set. */
  config: ServerConfig
  disabledAt: string
  /** Secret-store key holding the full config (state.json keeps a redacted copy). */
  secretRef?: string
}

/** What Claude Setup wrote into one settings file (value tags only, never secrets). */
export interface ModelWrittenFile {
  path: string
  env: Record<string, string>
  settings: Record<string, string>
}

/** Tracks model settings written by Claude Setup so reset() removes only what we own. */
export interface ModelApplyMarker {
  profileId?: string
  claudeCode?: ModelWrittenFile
  vscode?: ModelWrittenFile[]
  onboardingSet?: boolean
  updatedAt: string
}

export interface AppState {
  version: 1
  settings: AppSettings
  profiles: ModelProfile[]
  activeProfileId?: string
  installs: InstallRecord[]
  disabled: DisabledServerRecord[]
  proxy: ProxyConfig
  /** What Claude Setup wrote into Claude Code / VS Code settings. */
  modelApply?: ModelApplyMarker
}

export interface AppInfo {
  name: string
  version: string
  platform: OS
  arch: string
  dataDir: string
  /** 'gui' | 'cli' | 'mcp' */
  surface: 'gui' | 'cli' | 'mcp'
  /** How Claude Setup's own MCP server is launched from this install. */
  selfMcpConfig?: StdioServerConfig
  /** Why selfMcpConfig is unavailable (portable build, translocated app, …). */
  selfMcpUnavailableReason?: string
  packaged: boolean
}

export interface LogEvent {
  time: string
  level: 'debug' | 'info' | 'warn' | 'error'
  scope: string
  message: string
}
