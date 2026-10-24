/**
 * Builds Claude Setup's MCP server: one McpServer with every tool, backed by a lazily
 * created shared core. Kept free of side effects so tests can use an in-memory transport.
 */
import { McpServer } from '@modelcontextprotocol/server'
import type { CoreGetter } from './common'
import { SERVER_INSTRUCTIONS } from './instructions'
import { registerModelTools } from './modelTools'
import { registerServerTools } from './serverTools'
import { registerSystemTools } from './systemTools'

export type { CoreGetter } from './common'

/** Every tool name this server exposes. */
export const TOOL_NAMES = [
  'search_mcp_servers',
  'get_mcp_server',
  'install_mcp_server',
  'uninstall_mcp_server',
  'list_installed_mcp_servers',
  'test_mcp_server',
  'enable_disable_mcp_server',
  'list_targets',
  'restart_claude_desktop',
  'list_model_providers',
  'list_model_profiles',
  'get_model_status',
  'switch_model_profile',
  'reset_model_to_claude',
  'run_doctor',
  'apply_doctor_fix',
  'search_extensions',
  'install_extension',
  'uninstall_extension',
  'list_installed_extensions',
  'refresh_catalog',
  'list_backups',
  'restore_backup'
] as const

/** Register all tools on `server`. */
export function registerTools(server: McpServer, getCore: CoreGetter): void {
  registerServerTools(server, getCore)
  registerModelTools(server, getCore)
  registerSystemTools(server, getCore)
}

/** A fully configured McpServer instance. */
export function buildMcpServer(getCore: CoreGetter, version: string): McpServer {
  const server = new McpServer({ name: 'claude-setup', title: 'Claude Setup', version }, { instructions: SERVER_INSTRUCTIONS })
  registerTools(server, getCore)
  return server
}
