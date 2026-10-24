/** Shared CLI printers for core results (change results, tests, op results). */
import type { OpResult, TargetChangeResult, TestResult } from '@shared/types'
import { configLine, describeRef, tail } from '../mcp/format'
import type { CliContext } from './context'

export { configLine, describeRef, targetLabel, truncate } from '../mcp/format'

/** One line per target: ✔/✘, app, message, then file/backup details dimmed. */
export function printChangeResults(ctx: CliContext, results: TargetChangeResult[]): void {
  const { out } = ctx
  for (const r of results) {
    const icon = r.ok ? out.c.green(out.sym.ok) : out.c.red(out.sym.fail)
    out.line(`${icon} ${out.c.bold(describeRef(r.target))}: ${r.message}`)
    const details = [r.configPath ? `file: ${r.configPath}` : '', r.backupId ? `backup: ${r.backupId}` : ''].filter(Boolean).join(' · ')
    if (details) out.line(`  ${out.c.dim(details)}`)
  }
}

/** Print an OpResult (message, details, backup id, restart hint). */
export function printOpResult(ctx: CliContext, r: OpResult): void {
  const { out } = ctx
  if (r.ok) out.success(r.message)
  else out.error(r.message)
  if (r.details) for (const line of r.details.split('\n')) out.line(`  ${r.ok ? out.c.dim(line) : line}`)
  if (r.backupId) out.line(`  ${out.c.dim(`backup: ${r.backupId}`)}`)
  if (r.needsRestart) out.hint('Restart the affected app to apply the change.')
}

/** Print a server connection test (tools on success; error, hint and stderr tail on failure). */
export function printTestResult(ctx: CliContext, t: TestResult, label: string): void {
  const { out } = ctx
  const seconds = (t.ms / 1000).toFixed(1)
  if (t.ok) {
    const who = [t.serverName, t.serverVersion].filter(Boolean).join(' ')
    out.success(`${label} works ${out.c.dim(`(${seconds} s${who ? `, ${who}` : ''}${t.protocol ? `, protocol ${t.protocol}` : ''})`)}`)
    if (!t.tools.length) out.line(`  ${out.c.dim('It offers no tools.')}`)
    else {
      out.line(`  ${t.tools.length} tool${t.tools.length === 1 ? '' : 's'}:`)
      for (const tool of t.tools.slice(0, 30)) out.line(`    ${out.sym.bullet} ${tool.name}${tool.description ? out.c.dim(` ${out.sym.dash} ${tool.description.replace(/\s+/g, ' ').slice(0, 90)}`) : ''}`)
      if (t.tools.length > 30) out.line(`    ${out.c.dim(`… and ${t.tools.length - 30} more`)}`)
    }
    return
  }
  out.error(`${label} failed${t.kind ? ` (${t.kind})` : ''} after ${seconds} s`)
  if (t.error) out.line(`  ${t.error}`)
  if (t.hint) out.line(`  ${out.c.yellow('Hint:')} ${t.hint}`)
  const err = tail(t.stderr, 2000, 15)
  if (err) {
    out.line(`  ${out.c.dim('Server output (last lines):')}`)
    for (const line of err.split('\n')) out.line(`    ${out.c.dim(line)}`)
  }
}

/** "npx -y pkg" / "https://… (http)" with env names (values hidden). */
export function describeConfigForHumans(config: Parameters<typeof configLine>[0]): string {
  const base = configLine(config, 200)
  if (config.type === 'stdio' && config.env && Object.keys(config.env).length) return `${base}  (env: ${Object.keys(config.env).join(', ')})`
  if (config.type !== 'stdio' && config.headers && Object.keys(config.headers).length) return `${base}  (headers: ${Object.keys(config.headers).join(', ')})`
  return base
}
