import { ArrowRight, CircleAlert, Laptop, Play, Server, Square, SquareTerminal, Waypoints } from 'lucide-react'
import type { ProxyStatus } from '@shared/types'
import { Badge, Button, Card, CopyButton, ErrorState, IconTile, Skeleton, StatusDot, Switch } from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'
import { formatNumber, formatRelativeTime } from '@renderer/lib/format'

export interface ProxyStatusCardProps {
  status: ProxyStatus | undefined
  error: string | null
  onRetry: () => void
  onStart: () => void
  onStop: () => void
  busy: boolean
  autoStart: boolean | undefined
  onAutoStartChange: (on: boolean) => void
  savingAutoStart: boolean
  /** The config has at least one upstream (starting without one does nothing useful). */
  hasUpstreams: boolean
}

function Node({ icon, title, detail }: { icon: typeof Laptop; title: string; detail: string }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <IconTile icon={icon} tone="neutral" size="sm" />
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-fg">{title}</div>
        <div className="truncate text-xs text-fg-muted">{detail}</div>
      </div>
    </div>
  )
}

/** "How it works" strip: Claude Code → local proxy → OpenAI-style provider. */
export function ProxyExplainer() {
  return (
    <Card variant="muted" className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <Node icon={SquareTerminal} title="Claude Code" detail="Speaks Claude’s language" />
        <ArrowRight className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
        <Node icon={Waypoints} title="The proxy" detail="On this computer only" />
        <ArrowRight className="size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
        <Node icon={Server} title="Provider" detail="OpenAI, Gemini, Groq…" />
      </div>
      <p className="mt-3 text-[13px] leading-5 text-fg-muted">
        Some providers only understand OpenAI’s format. The proxy translates every request from Claude Code and passes it on
        with your key.
        It listens only on this computer and needs a private access token, so nothing else can use it. It stops when Claude Setup quits —
        keep Claude Setup running in the tray, or turn on “Start Claude Setup when you log in” in Settings.
      </p>
    </Card>
  )
}

/** Proxy status: running or not, address, counters, start/stop and auto-start. */
export function ProxyStatusCard(props: ProxyStatusCardProps) {
  const { status, error, onRetry, onStart, onStop, busy, autoStart, onAutoStartChange, savingAutoStart, hasUpstreams } = props
  if (!status) {
    if (error) {
      return (
        <Card>
          <ErrorState size="sm" title="Couldn’t check the proxy" error={error} onRetry={onRetry} />
        </Card>
      )
    }
    return (
      <Card className="p-6" aria-label="Loading proxy status">
        <div className="flex items-center gap-5">
          <Skeleton className="size-14 rounded-2xl" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-3.5 w-64" />
          </div>
          <Skeleton className="h-9 w-24 rounded-lg" />
        </div>
      </Card>
    )
  }

  const running = status.running
  return (
    <Card variant={running ? 'hero' : 'default'} className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-5 p-6">
        <div className="relative">
          <IconTile icon={Waypoints} tone={running ? 'success' : 'neutral'} size="xl" />
          <span className="absolute -top-0.5 -right-0.5">
            <StatusDot status={running ? 'ok' : 'idle'} label={null} />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold tracking-wide text-fg-muted uppercase">Translation proxy</p>
          <h2 className="text-xl leading-7 font-semibold tracking-[-0.015em] text-fg">{running ? 'Running' : 'Stopped'}</h2>
          {running && status.url ? (
            <div className="mt-0.5 flex items-center gap-1">
              <span className="truncate font-mono text-[13px] text-fg">{status.url}</span>
              <CopyButton text={status.url} label="Copy address" />
            </div>
          ) : (
            <p className="text-[13.5px] text-fg-muted">
              {hasUpstreams
                ? 'Claude Code can’t reach OpenAI-style providers while it’s stopped.'
                : 'Add an upstream below, then start it.'}
            </p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {running && status.startedAt ? (
              <span className="text-xs text-fg-subtle">Started {formatRelativeTime(status.startedAt)}</span>
            ) : null}
            {status.external ? (
              <Badge size="sm" tone="info">
                Running in another window or the terminal
              </Badge>
            ) : null}
          </div>
        </div>
        <dl className="flex gap-6 text-right">
          <div>
            <dt className="text-xs text-fg-muted">Requests</dt>
            <dd className="text-xl font-semibold text-fg tabular-nums">{formatNumber(status.requests)}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Errors</dt>
            <dd className={cn('text-xl font-semibold tabular-nums', status.errors ? 'text-danger-text' : 'text-fg')}>
              {formatNumber(status.errors)}
            </dd>
          </div>
        </dl>
        {running ? (
          <Button leftIcon={Square} loading={busy} onClick={onStop} disabled={status.external}>
            Stop
          </Button>
        ) : (
          <Button variant="primary" leftIcon={Play} loading={busy} onClick={onStart} disabled={!hasUpstreams}>
            Start
          </Button>
        )}
      </div>
      {status.lastError ? (
        <div className="flex items-start gap-2.5 border-t border-danger-line/60 bg-danger-soft/50 px-6 py-3" role="status">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger-text" aria-hidden="true" />
          <p className="text-[13px] leading-5 text-fg-muted">
            <span className="font-medium text-fg">Last error: </span>
            {status.lastError}
          </p>
        </div>
      ) : null}
      <div className="border-t border-line px-6 py-4">
        <Switch
          checked={autoStart ?? false}
          disabled={autoStart === undefined || savingAutoStart}
          onCheckedChange={onAutoStartChange}
          label="Start the proxy together with Claude Setup"
          description="Recommended while Claude Code uses a provider that needs it."
        />
      </div>
    </Card>
  )
}
