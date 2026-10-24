import { Pause, Play, ScrollText, Trash2 } from 'lucide-react'
import type { ProxyLogEntry } from '@shared/types'
import { Badge, Button, Chip, EmptyState, ErrorState, Skeleton, StatusDot, TBody, TD, TH, THead, TR } from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'
import { formatDateTime, formatDuration } from '@renderer/lib/format'
import { filterLogs, logTime, statusTone, type LogFilter } from './logic'

export interface LogTableProps {
  entries: ProxyLogEntry[] | undefined
  loading: boolean
  error: string | null
  onRetry: () => void
  filter: LogFilter
  onFilterChange: (filter: LogFilter) => void
  paused: boolean
  onPauseChange: (paused: boolean) => void
  onClear: () => void
}

const LEVEL_DOT = { info: 'idle', warn: 'warn', error: 'error' } as const
const LEVEL_TEXT = { info: 'text-fg-muted', warn: 'text-warn-text', error: 'text-danger-text' } as const

/** Live proxy log: newest first, level colors, filters, pause and clear. */
export function LogTable({ entries, loading, error, onRetry, filter, onFilterChange, paused, onPauseChange, onClear }: LogTableProps) {
  const all = entries ?? []
  const rows = filterLogs(all, filter).slice(0, 300)
  const counts = { all: all.length, warn: filterLogs(all, 'warn').length, error: filterLogs(all, 'error').length }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter log entries">
          <Chip size="sm" selected={filter === 'all'} count={counts.all} onClick={() => onFilterChange('all')}>
            All
          </Chip>
          <Chip size="sm" selected={filter === 'warn'} count={counts.warn} onClick={() => onFilterChange('warn')}>
            Warnings & errors
          </Chip>
          <Chip size="sm" selected={filter === 'error'} count={counts.error} onClick={() => onFilterChange('error')}>
            Errors
          </Chip>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {!paused ? (
            <span className="mr-1 inline-flex items-center gap-1.5 text-xs text-fg-muted">
              <StatusDot status="busy" size="sm" label={null} />
              Live
            </span>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            leftIcon={paused ? Play : Pause}
            onClick={() => onPauseChange(!paused)}
            aria-pressed={paused}
          >
            {paused ? 'Resume' : 'Pause'}
          </Button>
          <Button size="sm" variant="ghost" leftIcon={Trash2} onClick={onClear} disabled={all.length === 0}>
            Clear view
          </Button>
        </div>
      </div>

      {error && !entries ? (
        <ErrorState framed size="sm" title="Couldn’t load the proxy log" error={error} onRetry={onRetry} />
      ) : loading && !entries ? (
        <div className="space-y-2 rounded-xl border border-line bg-surface p-4" aria-label="Loading log">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          framed
          size="sm"
          icon={ScrollText}
          title={all.length ? 'Nothing matches this filter' : 'No requests yet'}
          description={all.length ? 'Try “All”.' : 'Start the proxy and use Claude Code — each request shows up here.'}
        />
      ) : (
        <div className="max-h-[420px] overflow-auto rounded-xl border border-line bg-surface shadow-xs">
          <table className="w-full border-collapse text-left text-[13px]" aria-label="Proxy log">
            <THead className="sticky top-0 z-[1] bg-surface-2">
              <TR>
                <TH>Time</TH>
                <TH>Event</TH>
                <TH>Model</TH>
                <TH>Upstream</TH>
                <TH align="right">Status</TH>
                <TH align="right">Took</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((entry, i) => (
                <TR key={`${entry.time}-${i}`}>
                  <TD className="whitespace-nowrap text-fg-muted tabular-nums" title={formatDateTime(entry.time)}>
                    {logTime(entry.time)}
                  </TD>
                  <TD>
                    <span className="flex items-start gap-2">
                      <span className="mt-[5px] flex">
                        <StatusDot status={LEVEL_DOT[entry.level]} size="sm" pulse={false} label={entry.level} />
                      </span>
                      <span className={cn('break-words', entry.level === 'info' ? 'text-fg' : LEVEL_TEXT[entry.level])}>
                        {entry.message}
                      </span>
                    </span>
                  </TD>
                  <TD mono className="whitespace-nowrap text-fg-muted">
                    {entry.model ?? '—'}
                  </TD>
                  <TD mono className="whitespace-nowrap text-fg-muted">
                    {entry.upstream ?? '—'}
                  </TD>
                  <TD align="right">
                    {entry.status ? (
                      <Badge size="sm" tone={statusTone(entry.status)}>
                        {entry.status}
                      </Badge>
                    ) : (
                      <span className="text-fg-subtle">—</span>
                    )}
                  </TD>
                  <TD align="right" className="whitespace-nowrap text-fg-muted">
                    {entry.ms !== undefined ? formatDuration(entry.ms) : '—'}
                  </TD>
                </TR>
              ))}
            </TBody>
          </table>
        </div>
      )}
    </div>
  )
}
