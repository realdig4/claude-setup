/** Shared pieces for MCP tool definitions: schemas, target parsing, error wrapping. */
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { CoreApi } from '@shared/api'
import type { Scope, TargetId, TargetRef } from '@shared/types'
import { UserError, errorResult, targetLabel, type ToolResult } from './format'
import { SERVER_NAME_RE } from './helpers'

export { SERVER_NAME_RE, defaultModelTargets, splitCommandLine } from './helpers'

/** Lazily resolves the shared core (created on first use). */
export type CoreGetter = () => Promise<CoreApi>

/** Apps that can receive MCP servers. */
export const targetIdSchema = z.enum(['claude-desktop', 'claude-code', 'vscode', 'cursor', 'windsurf'])
/** Claude Code / VS Code config scopes. */
export const scopeSchema = z.enum(['user', 'project', 'local'])
/** Where third-party model settings can be written. */
export const modelTargetSchema = z.enum(['claude-code', 'vscode'])
/** String-to-string map (env vars, headers). */
export const stringMapSchema = z.record(z.string(), z.string())

/** MCP tool behaviour hints. */
export interface ToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/** Metadata for defineTool(). */
export interface ToolDefinition<S extends z.ZodObject> {
  title: string
  description: string
  inputSchema: S
  annotations: ToolAnnotations
}

/**
 * Register a tool whose handler errors become friendly `isError` results instead of protocol errors.
 */
export function defineTool<S extends z.ZodObject>(
  server: McpServer,
  name: string,
  def: ToolDefinition<S>,
  handler: (args: z.output<S>) => Promise<ToolResult>
): void {
  const wrapped = async (args: z.output<S>): Promise<ToolResult> => {
    try {
      return await handler(args)
    } catch (err) {
      return errorResult(err)
    }
  }
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { title: string; description: string; inputSchema: S; annotations: ToolAnnotations & { title: string } },
    cb: (args: z.output<S>) => Promise<ToolResult>
  ) => unknown
  register(name, { title: def.title, description: def.description, inputSchema: def.inputSchema, annotations: { title: def.title, ...def.annotations } }, wrapped)
}

/** Validate a server/config name. */
export function assertServerName(name: string): void {
  if (!SERVER_NAME_RE.test(name)) {
    throw new UserError(`"${name}" is not a valid server name. Use 1-64 letters, numbers, "-" or "_" (no spaces).`)
  }
}

/**
 * Turn target ids + optional scope into TargetRefs. Scope applies to Claude Code (user/project/local)
 * and VS Code (user/project); project and local scopes need an absolute project folder.
 */
export function refsFor(targets: TargetId[], scope?: Scope, projectPath?: string): TargetRef[] {
  if (!targets.length) throw new UserError('Choose at least one app (target).')
  if ((scope === 'project' || scope === 'local') && !projectPath) {
    throw new UserError(`The "${scope}" scope needs project_path: the full path of the project folder.`)
  }
  if (projectPath && !isAbsolute(projectPath)) throw new UserError('project_path must be a full (absolute) folder path.')
  return [...new Set(targets)].map((target) => {
    if (target === 'claude-code' && scope) return { target, scope, ...(scope !== 'user' ? { projectPath } : {}) }
    if (target === 'vscode' && scope) {
      if (scope === 'local') throw new UserError('VS Code supports the "user" and "project" scopes only.')
      return { target, scope, ...(scope === 'project' ? { projectPath } : {}) }
    }
    return { target }
  })
}

/** Comma-separated app labels for target ids. */
export function listLabels(ids: string[]): string {
  return ids.map(targetLabel).join(', ')
}
