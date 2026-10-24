/**
 * CoreContext — the shared services every core module receives.
 * Owned by the FOUNDATION module. Signatures are a contract: do not change
 * them without updating docs/ARCHITECTURE.md.
 */
import { join } from 'node:path'
import type { StdioServerConfig } from '@shared/types'
import { CoreEmitter } from './events'
import { BackupManager } from './fs/backups'
import { appDataDir } from './platform/paths'
import { createSecretStore, type SecretStore } from './secrets'
import { StateStore } from './state'

export interface CoreOptions {
  surface: 'gui' | 'cli' | 'mcp'
  appVersion: string
  /** Override the data directory (tests). Defaults to appDataDir(). */
  dataDir?: string
  packaged?: boolean
  /** How this installation launches its own MCP server (set by the entry point). */
  selfMcpConfig?: StdioServerConfig
  /** Inject a different secret store (tests). */
  secretStore?: SecretStore
}

export interface Logger {
  debug(scope: string, message: string): void
  info(scope: string, message: string): void
  warn(scope: string, message: string): void
  error(scope: string, message: string): void
}

export interface CoreContext {
  options: CoreOptions
  /** ~/.../Claude Setup (state.json, secrets, backups, cache) */
  dataDir: string
  cacheDir: string
  state: StateStore
  secrets: SecretStore
  backups: BackupManager
  events: CoreEmitter
  log: Logger
}

export async function createContext(options: CoreOptions): Promise<CoreContext> {
  const dataDir = options.dataDir ?? appDataDir()
  const events = new CoreEmitter()
  const log: Logger = {
    debug: (scope, message) => events.emitEvent('log', { time: new Date().toISOString(), level: 'debug', scope, message }),
    info: (scope, message) => events.emitEvent('log', { time: new Date().toISOString(), level: 'info', scope, message }),
    warn: (scope, message) => events.emitEvent('log', { time: new Date().toISOString(), level: 'warn', scope, message }),
    error: (scope, message) => events.emitEvent('log', { time: new Date().toISOString(), level: 'error', scope, message })
  }
  const state = new StateStore(join(dataDir, 'state.json'))
  await state.load()
  const secrets = options.secretStore ?? createSecretStore(dataDir)
  const backups = new BackupManager(join(dataDir, 'backups'), () => state.get().settings.keepBackups)
  return { options, dataDir, cacheDir: join(dataDir, 'cache'), state, secrets, backups, events, log }
}
