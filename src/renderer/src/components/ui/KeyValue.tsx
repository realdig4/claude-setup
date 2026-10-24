import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { CopyButton } from './CopyButton'

export interface KeyValueItem {
  label: ReactNode
  value: ReactNode
  /** Monospace value (paths, ids, commands). */
  mono?: boolean
  /** Text to copy — shows a copy button next to the value. */
  copy?: string
  /** Quiet note under the value. */
  hint?: ReactNode
}

export interface KeyValueProps {
  items: ReadonlyArray<KeyValueItem | null | false | undefined>
  /** Label column width (CSS length, default 'minmax(120px, max-content)'). */
  labelWidth?: string
  className?: string
}

/**
 * Definition list of label → value rows (falsy items are skipped).
 * @example <KeyValue items={[{ label: 'Version', value: '2.1.309' }, { label: 'Config file', value: path, mono: true, copy: path }]} />
 */
export function KeyValue({ items, labelWidth = 'minmax(120px, max-content)', className }: KeyValueProps) {
  const rows = items.filter((item): item is KeyValueItem => !!item)
  return (
    <dl className={cn('grid gap-x-6 gap-y-3 text-[13px] leading-5', className)} style={{ gridTemplateColumns: `${labelWidth} minmax(0, 1fr)` }}>
      {rows.map((item, i) => (
        <div key={i} className="contents">
          <dt className="pt-px text-fg-muted">{item.label}</dt>
          <dd className="m-0 min-w-0">
            <div className="flex items-start gap-1.5">
              <div className={cn('min-w-0 flex-1 text-fg', item.mono && 'font-mono text-[12px] leading-5 break-all')}>{item.value}</div>
              {item.copy ? <CopyButton text={item.copy} label="Copy" className="-my-1.5 shrink-0" /> : null}
            </div>
            {item.hint ? <div className="mt-0.5 text-xs text-fg-subtle">{item.hint}</div> : null}
          </dd>
        </div>
      ))}
    </dl>
  )
}
