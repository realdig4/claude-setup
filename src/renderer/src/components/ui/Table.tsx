import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

/**
 * Styled table primitives for dense Advanced views (proxy logs, backup files, env vars).
 * @example
 * <Table>
 *   <THead><TR><TH>Time</TH><TH>Model</TH><TH align="right">ms</TH></TR></THead>
 *   <TBody>{rows.map((r) => <TR key={r.id}><TD>{r.time}</TD><TD mono>{r.model}</TD><TD align="right">{r.ms}</TD></TR>)}</TBody>
 * </Table>
 */
export function Table({ className, children, ...props }: ComponentProps<'table'>) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-xs">
      <table className={cn('w-full border-collapse text-left text-[13px]', className)} {...props}>
        {children}
      </table>
    </div>
  )
}

export function THead({ className, ...props }: ComponentProps<'thead'>) {
  return <thead className={cn('border-b border-line bg-surface-2/60', className)} {...props} />
}

export function TBody({ className, ...props }: ComponentProps<'tbody'>) {
  return <tbody className={cn('divide-y divide-line', className)} {...props} />
}

export function TR({ className, ...props }: ComponentProps<'tr'>) {
  return <tr className={cn('transition-colors hover:bg-surface-2/40', className)} {...props} />
}

export interface CellProps {
  align?: 'left' | 'right' | 'center'
  mono?: boolean
}

export function TH({ className, align = 'left', mono: _mono, ...props }: ComponentProps<'th'> & CellProps) {
  return (
    <th
      scope="col"
      className={cn(
        'px-4 py-2.5 text-2xs font-semibold tracking-[0.06em] whitespace-nowrap text-fg-subtle uppercase',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        className
      )}
      {...props}
    />
  )
}

export function TD({ className, align = 'left', mono, ...props }: ComponentProps<'td'> & CellProps) {
  return (
    <td
      className={cn(
        'px-4 py-2.5 align-middle text-fg',
        align === 'right' && 'text-right tabular-nums',
        align === 'center' && 'text-center',
        mono && 'font-mono text-xs',
        className
      )}
      {...props}
    />
  )
}
