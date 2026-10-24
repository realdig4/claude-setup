/**
 * Internal contract every target (app that consumes MCP servers) implements.
 * Not part of the public CoreApi — the ServersApi / TargetsApi are built on top of it.
 */
import type { InstalledServer, Scope, ServerConfig, TargetChangeResult, TargetId, TargetInfo, TargetRef } from '@shared/types'

/** A TargetRef with the scope filled in and the project path resolved. */
export interface NormalizedRef {
  target: TargetId
  scope: Scope
  /** Absolute project folder (only for 'project' / 'local' scopes). */
  projectPath?: string
}

export interface SupportResult {
  ok: boolean
  /** Why the config cannot be used, or what will change when it is written (shown to the user). */
  reason?: string
  /** A remote server is wrapped in a local stdio bridge (Claude Desktop + mcp-remote). */
  bridged?: boolean
}

export interface AddOptions {
  /** Replace an existing entry with the same name. */
  overwrite?: boolean
  /**
   * Write this exact native entry instead of converting `config` (restores a turned-off server verbatim,
   * keeping app-specific fields such as VS Code's envFile or Claude Code's oauth block).
   */
  native?: Record<string, unknown>
}

/** An entry currently present in a target's config file. */
export interface FoundServer {
  name: string
  config: ServerConfig
  /** The raw entry exactly as stored in the app's file. */
  native: unknown
  configPath: string
}

export interface TargetAdapter {
  readonly id: TargetId
  readonly label: string
  readonly description: string
  readonly scopes: Scope[]
  readonly supportsRemote: boolean
  /** Shown first in Simple mode. */
  readonly primary: boolean
  info(): Promise<TargetInfo>
  /** Primary config file for a ref (resolved physical path). */
  configFile(ref: NormalizedRef): Promise<string>
  /** Every file this ref writes to, primary first (mirrors such as Claude Desktop's 3P profile follow). */
  configFiles(ref: NormalizedRef): Promise<string[]>
  /** Servers in the config plus servers turned off through Claude Setup (enabled: false). */
  list(ref: NormalizedRef): Promise<InstalledServer[]>
  /** A server currently present in the config (turned-off servers are not included). */
  get(ref: NormalizedRef, name: string): Promise<FoundServer | null>
  /** Any entry with this name in the config, even one Claude Setup can't interpret. */
  exists(ref: NormalizedRef, name: string): Promise<boolean>
  add(ref: NormalizedRef, name: string, config: ServerConfig, opts?: AddOptions): Promise<TargetChangeResult>
  remove(ref: NormalizedRef, name: string): Promise<TargetChangeResult>
  /** Environment-dependent adjustments before writing (bridging, absolute command paths). */
  prepare(config: ServerConfig): Promise<ServerConfig>
  /** Pure mapping to the app's native entry shape. */
  toNative(config: ServerConfig): Record<string, unknown>
  /** Pure mapping back from a native entry; null when the entry is not a usable server. */
  fromNative(entry: unknown): ServerConfig | null
  supports(config: ServerConfig): SupportResult
  /** Pretty JSON showing exactly what will be written, in the app's own file layout. */
  snippet(ref: NormalizedRef, name: string, config: ServerConfig): Promise<string>
}

/** Public ref shape returned to callers: single-scope apps omit the scope. */
export type PublicRef = TargetRef
