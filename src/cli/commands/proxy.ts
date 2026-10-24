/** `proxy start` (foreground until Ctrl+C) and `proxy status`. */
import type { Command } from 'commander'
import type { ProxyLogEntry, ProxyStatus } from '@shared/types'
import type { CliContext } from '../context'
import { CliError, EXIT } from '../errors'

/** Resolves when the process receives Ctrl+C (SIGINT) or SIGTERM. */
export function waitForStopSignal(): Promise<string> {
  return new Promise((resolve) => {
    const done = (signal: string): void => {
      process.off('SIGINT', onInt)
      process.off('SIGTERM', onTerm)
      resolve(signal)
    }
    const onInt = (): void => done('SIGINT')
    const onTerm = (): void => done('SIGTERM')
    process.once('SIGINT', onInt)
    process.once('SIGTERM', onTerm)
  })
}

function printStatus(ctx: CliContext, st: ProxyStatus): void {
  const { out } = ctx
  if (!st.running) {
    out.line(`The model proxy is ${out.c.bold('stopped')}.`)
    out.hint('Start it with: claude-setup proxy start')
    return
  }
  out.line(`The model proxy is ${out.c.green('running')}${st.url ? ` at ${st.url}` : st.port ? ` on port ${st.port}` : ''}${st.external ? ' (in another window)' : ''}.`)
  out.pairs([
    ['Started', st.startedAt],
    ['Requests', String(st.requests)],
    ['Errors', String(st.errors)],
    ['Last error', st.lastError]
  ])
}

/** Register `proxy start|status`. */
export function registerProxyCommands(program: Command, ctx: CliContext): void {
  const proxy = program.command('proxy').description('Local translation proxy for OpenAI-only providers (OpenAI, Gemini, Groq…)')

  proxy
    .command('start')
    .description('Run the proxy in this terminal (press Ctrl+C to stop)')
    .action(async () => {
      const core = await ctx.core()
      const before = await core.proxy.status()
      if (before.running && before.external) {
        if (ctx.json) return ctx.out.printJson(before)
        ctx.out.info(`The proxy is already running in another window${before.url ? ` at ${before.url}` : ''}.`)
        return
      }
      const st = await ctx.out.withSpinner('Starting the proxy…', () => core.proxy.start())
      if (!st.running) throw new CliError(`The proxy did not start${st.lastError ? `: ${st.lastError}` : '.'}`, EXIT.failed, 'Check the proxy settings in the Claude Setup app (Models → Proxy).')
      if (ctx.json) ctx.out.printJson(st)
      else {
        ctx.out.success(`Proxy running${st.url ? ` at ${st.url}` : st.port ? ` on port ${st.port}` : ''}. Press Ctrl+C to stop.`)
      }
      const { out } = ctx
      const off = core.ctx.events.on('proxy', (e: ProxyLogEntry) => {
        if (ctx.json) return
        const time = e.time.slice(11, 19)
        const paint = e.level === 'error' ? out.c.red : e.level === 'warn' ? out.c.yellow : (t: string) => t
        const meta = [e.model, e.upstream, e.status ? String(e.status) : '', e.ms !== undefined ? `${e.ms} ms` : ''].filter(Boolean).join(' · ')
        out.line(`${out.c.dim(time)} ${paint(e.message)}${meta ? out.c.dim(`  ${meta}`) : ''}`)
      })
      await waitForStopSignal()
      off()
      const after = await core.proxy.stop().catch(() => null)
      if (!ctx.json) ctx.out.line(after && !after.running ? 'Proxy stopped.' : 'Stopping the proxy…')
    })

  proxy
    .command('status')
    .description('Show whether the proxy is running')
    .action(async () => {
      const core = await ctx.core()
      const st = await core.proxy.status()
      if (ctx.json) return ctx.out.printJson(st)
      printStatus(ctx, st)
    })
}
