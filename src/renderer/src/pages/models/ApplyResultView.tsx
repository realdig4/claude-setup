import { ArrowRight, CircleCheck, CircleX, Info, RotateCw, ShieldAlert, TriangleAlert } from 'lucide-react'
import type { ApplyModelResult } from '@shared/types'
import { AdvancedOnly, Button, Callout, IconTile, PathText } from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'
import { useNavigate } from '@renderer/lib/store'
import { CAVEAT, TARGET_LABELS, classifyWarnings } from './logic'

export interface ApplyResultViewProps {
  result: ApplyModelResult
  /** "Reset" wording ("Back to Claude") instead of "Using …". */
  mode?: 'apply' | 'reset'
  /** Third-party provider: show Anthropic's caveat even if the core didn't send it. */
  thirdParty?: boolean
  /** The provider goes through the local translation proxy. */
  proxy?: boolean
  /** Show the big icon + headline (hide it when a dialog title already says it). Default true. */
  headline?: boolean
  /** Replace the automatic headline text. */
  title?: string
  className?: string
}

function headlineFor(allOk: boolean, okCount: number, mode: 'apply' | 'reset'): string {
  if (allOk) return mode === 'reset' ? 'Back to Claude' : 'You’re all set!'
  return okCount > 0 ? 'Partly done' : 'Nothing was changed'
}

/** Outcome of applying a model setup (or going back to Claude): per-app results, next steps and notes. */
export function ApplyResultView(props: ApplyResultViewProps) {
  const { result, mode = 'apply', thirdParty, proxy, headline: showHeadline = true, title, className } = props
  const navigate = useNavigate()
  const { steps, caveat, notes } = classifyWarnings(result.warnings)
  const okCount = result.results.filter((r) => r.ok).length
  const allOk = result.results.length > 0 && okCount === result.results.length
  const headline = title ?? headlineFor(allOk, okCount, mode)
  const tone = allOk ? 'success' : okCount > 0 ? 'warn' : 'danger'
  const showCaveat = mode === 'apply' && (caveat || thirdParty)

  return (
    <div className={cn('flex flex-col gap-5', className)}>
      {showHeadline ? (
        <div className="flex items-center gap-4">
          <IconTile icon={allOk ? CircleCheck : okCount > 0 ? TriangleAlert : CircleX} tone={tone} size="lg" />
          <div className="min-w-0">
            <h3 className="text-lg leading-7 font-semibold tracking-[-0.01em] text-fg">{headline}</h3>
            <p className="text-[13.5px] leading-5 text-fg-muted">
              {allOk
                ? steps.length
                  ? 'One last step and you’re ready to go.'
                  : 'Your settings were saved.'
                : 'Read the details below to see what to do next.'}
            </p>
          </div>
        </div>
      ) : null}

      {result.results.length > 0 ? (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface" aria-label="Results per app">
          {result.results.map((r) => (
            <li key={r.target} className="flex items-start gap-3 px-4 py-3">
              {r.ok ? (
                <CircleCheck className="mt-0.5 size-[18px] shrink-0 text-success-text" aria-hidden="true" />
              ) : (
                <CircleX className="mt-0.5 size-[18px] shrink-0 text-danger-text" aria-hidden="true" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-fg">
                  {TARGET_LABELS[r.target].title}
                  <span className="sr-only">{r.ok ? ' — done' : ' — failed'}</span>
                </div>
                <p className="text-[13px] leading-5 text-fg-muted">{r.message}</p>
                <AdvancedOnly>
                  {r.configPath || r.backupId ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                      {r.configPath ? <PathText path={r.configPath} copy reveal /> : null}
                      {r.backupId ? <span className="font-mono text-xs text-fg-subtle">Backup {r.backupId}</span> : null}
                    </div>
                  ) : null}
                </AdvancedOnly>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {steps.length > 0 ? (
        <div className="rounded-xl border border-accent-line/60 bg-accent-soft/50 px-4 py-3.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-fg">
            <RotateCw className="size-4 text-accent-text" aria-hidden="true" />
            {steps.length === 1 ? 'Next step' : 'Next steps'}
          </div>
          <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5 text-[13.5px] leading-5 text-fg-muted marker:text-accent-text">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}

      {proxy && result.proxyStarted === false ? (
        <Callout
          tone="warn"
          title="The local proxy didn’t start"
          action={
            <Button size="sm" rightIcon={ArrowRight} onClick={() => navigate('proxy')}>
              Open Proxy
            </Button>
          }
        >
          Claude Code is set up to use it, but it isn’t running yet. Start it from the Proxy page or run a Health Check.
        </Callout>
      ) : null}

      {notes.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="Good to know">
          {notes.map((note) => (
            <li key={note} className="flex items-start gap-2.5 text-[13px] leading-5 text-fg-muted">
              <Info className="mt-0.5 size-4 shrink-0 text-info-text" aria-hidden="true" />
              <span>{note}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {showCaveat ? (
        <p className="flex items-start gap-2 border-t border-line pt-4 text-xs leading-5 text-fg-subtle">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{caveat ?? CAVEAT}</span>
        </p>
      ) : null}
    </div>
  )
}
