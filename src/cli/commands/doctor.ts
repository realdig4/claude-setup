/** `doctor [--fix]`: health checks with optional automatic fixes. */
import type { Command } from 'commander'
import type { CheckStatus, DoctorCheck, DoctorReport, OpResult } from '@shared/types'
import type { CliContext } from '../context'
import { EXIT } from '../errors'

const ORDER: CheckStatus[] = ['error', 'warn', 'info', 'ok', 'skip']
const CATEGORY_LABELS: Record<DoctorCheck['category'], string> = {
  runtimes: 'Runtimes',
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  vscode: 'VS Code',
  models: 'Models',
  mcp: 'MCP servers',
  system: 'System'
}

function printReport(ctx: CliContext, report: DoctorReport): void {
  const { out } = ctx
  const icon: Record<CheckStatus, string> = {
    ok: out.c.green(out.sym.ok),
    warn: out.c.yellow(out.sym.warn),
    error: out.c.red(out.sym.fail),
    info: out.c.cyan(out.sym.info),
    skip: out.c.dim('-')
  }
  const categories = [...new Set(report.checks.map((c) => c.category))]
  for (const category of categories) {
    out.line(out.c.bold(CATEGORY_LABELS[category] ?? category))
    const checks = report.checks.filter((c) => c.category === category).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
    for (const c of checks) {
      out.line(`  ${icon[c.status]} ${c.title}`)
      if (c.detail && c.status !== 'ok') out.line(`    ${out.c.dim(c.detail.replace(/\s+/g, ' '))}`)
      if (c.fix && c.status !== 'ok') out.line(`    ${out.c.cyan(out.sym.arrow)} ${c.fix.label}${c.fix.auto ? out.c.dim(' (claude-setup doctor --fix)') : ''}`)
      if (c.docsUrl && c.status !== 'ok') out.line(`    ${out.c.dim(c.docsUrl)}`)
    }
  }
  const s = report.summary
  out.line()
  out.line(
    [`${s.ok ?? 0} ok`, s.warn ? out.c.yellow(`${s.warn} warning${s.warn === 1 ? '' : 's'}`) : '', s.error ? out.c.red(`${s.error} problem${s.error === 1 ? '' : 's'}`) : '', s.info ? `${s.info} note${s.info === 1 ? '' : 's'}` : '']
      .filter(Boolean)
      .join(out.c.dim(' · '))
  )
}

/** Register `doctor [--fix]`. */
export function registerDoctorCommand(program: Command, ctx: CliContext): void {
  program
    .command('doctor')
    .description('Check that Claude, its apps and your MCP servers are set up correctly')
    .option('--fix', 'Apply every automatic fix (config files are backed up first)')
    .option('-y, --yes', 'Apply fixes without asking')
    .action(async (opts: { fix?: boolean; yes?: boolean }) => {
      const core = await ctx.core()
      let report = await ctx.out.withSpinner('Checking your setup…', () => core.doctor.run())
      const fixes: Array<{ check: string; fixId: string; result: OpResult }> = []
      if (opts.fix) {
        const fixable = report.checks.filter((c) => c.fix?.auto && c.status !== 'ok' && c.status !== 'skip')
        if (fixable.length && !ctx.json) {
          ctx.out.line(ctx.out.c.bold(`${fixable.length} automatic fix${fixable.length === 1 ? '' : 'es'} available:`))
          for (const c of fixable) ctx.out.line(`  ${ctx.out.sym.bullet} ${c.fix?.label} ${ctx.out.c.dim(`(${c.title})`)}`)
        }
        if (fixable.length && (await ctx.confirmOrYes('Apply them now?', opts.yes))) {
          for (const c of fixable) {
            const fixId = c.fix?.id as string
            const result = await ctx.out.withSpinner(`${c.fix?.label}…`, () =>
              core.doctor.fix(fixId).catch((err: Error): OpResult => ({ ok: false, message: err.message }))
            )
            fixes.push({ check: c.id, fixId, result })
            if (!ctx.json) {
              if (result.ok) ctx.out.success(result.message)
              else ctx.out.error(result.message)
            }
          }
          report = await ctx.out.withSpinner('Checking again…', () => core.doctor.run())
        } else if (!fixable.length && !ctx.json) {
          ctx.out.info('There is nothing to fix automatically.')
        }
        if (!ctx.json) ctx.out.line()
      }
      if (report.checks.some((c) => c.status === 'error') || fixes.some((f) => !f.result.ok)) ctx.fail(EXIT.failed)
      if (ctx.json) return ctx.out.printJson(opts.fix ? { report, fixes } : report)
      printReport(ctx, report)
    })
}
