import { useId, type ComponentProps, type ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface SwitchProps extends Omit<ComponentProps<'button'>, 'onChange' | 'value'> {
  checked: boolean
  onCheckedChange?: (checked: boolean) => void
  size?: 'sm' | 'md'
  /** Optional visible label (clicking it toggles the switch). Without it, pass aria-label. */
  label?: ReactNode
  /** Secondary text under the label. */
  description?: ReactNode
}

const TRACK = { sm: 'h-4 w-7', md: 'h-5 w-9' }
const KNOB = { sm: 'size-3 data-[on=true]:translate-x-3', md: 'size-4 data-[on=true]:translate-x-4' }

/**
 * On/off toggle (role="switch"). Use for settings that apply immediately.
 * @example <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="Enable GitHub tool" />
 * @example <Switch checked={auto} onCheckedChange={setAuto} label="Restart Claude automatically" />
 */
export function Switch({ checked, onCheckedChange, size = 'md', label, description, className, id, disabled, ...props }: SwitchProps) {
  const autoId = useId()
  const switchId = id ?? `switch-${autoId}`
  const descriptionId = description ? `${switchId}-desc` : undefined
  const control = (
    <button
      id={switchId}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-describedby={descriptionId}
      disabled={disabled}
      data-on={checked}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        'group relative inline-flex shrink-0 items-center rounded-full p-0.5 transition-colors duration-200 ease-smooth',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-accent-solid' : 'bg-surface-3 inset-shadow-[0_0_0_1px_var(--color-line-strong)]',
        TRACK[size],
        !label && className
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        data-on={checked}
        className={cn(
          'block rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform duration-200 ease-smooth',
          KNOB[size]
        )}
      />
    </button>
  )
  if (!label) return control
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <label htmlFor={switchId} className={cn('text-sm font-medium text-fg', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}>
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="mt-0.5 text-[13px] leading-5 text-fg-muted">
            {description}
          </p>
        ) : null}
      </div>
      <div className="pt-0.5">{control}</div>
    </div>
  )
}
