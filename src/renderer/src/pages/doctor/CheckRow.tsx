import { Wrench } from 'lucide-react'
import type { DoctorCheck } from '@shared/types'
import { Badge, Button, ExternalLink, StatusDot } from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'
import { STATUS_META } from './meta'

export interface CheckRowProps {
  check: DoctorCheck
  onFix: (check: DoctorCheck) => void
  fixing: boolean
  advanced: boolean
  /** Show the plain-words meaning of the status (Simple mode "needs attention" list). */
  explain?: boolean
  /** Quieter look for passing checks. */
  compact?: boolean
}

/** One health check: status, title, details and a "Fix it" button or a manual step. */
export function CheckRow({ check, onFix, fixing, advanced, explain, compact }: CheckRowProps) {
  const meta = STATUS_META[check.status]
  const fix = check.fix
  const attention = check.status === 'error' || check.status === 'warn' || check.status === 'info'

  return (
    <li className={cn('flex items-start gap-3.5 px-4', compact ? 'py-3' : 'py-4')}>
      <span className="mt-[7px] flex shrink-0">
        <StatusDot status={meta.dot} pulse={false} label={meta.label} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('text-sm leading-6 font-medium', check.status === 'skip' ? 'text-fg-muted' : 'text-fg')}>
            {check.title}
          </span>
          {attention && !compact ? (
            <Badge size="sm" tone={meta.tone}>
              {meta.label}
            </Badge>
          ) : null}
        </div>
        {check.detail ? <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">{check.detail}</p> : null}
        {explain && attention ? <p className="mt-1 text-xs leading-5 text-fg-subtle">{meta.meaning}</p> : null}
        {fix && !fix.auto ? (
          <p className="mt-1.5 flex items-start gap-1.5 text-[13px] leading-5 text-fg">
            <Wrench className="mt-[3px] size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
            <span>{fix.label}</span>
          </p>
        ) : null}
        {check.docsUrl || advanced ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
            {check.docsUrl ? (
              <ExternalLink href={check.docsUrl} className="text-[13px]">
                Learn more
              </ExternalLink>
            ) : null}
            {advanced ? <span className="font-mono text-[11px] text-fg-subtle">{check.id}</span> : null}
          </div>
        ) : null}
      </div>
      {fix?.auto ? (
        <Button size="sm" leftIcon={Wrench} loading={fixing} onClick={() => onFix(check)} className="shrink-0">
          {fix.label}
        </Button>
      ) : null}
    </li>
  )
}
