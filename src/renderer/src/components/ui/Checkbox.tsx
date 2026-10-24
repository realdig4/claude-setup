import { useEffect, useId, useRef, type ComponentProps, type ReactNode } from 'react'
import { Check, Minus } from 'lucide-react'
import { cn } from '../../lib/cn'

export interface CheckboxProps extends Omit<ComponentProps<'input'>, 'type' | 'onChange' | 'size'> {
  checked: boolean
  onCheckedChange?: (checked: boolean) => void
  /** Shows a dash (e.g. "some selected"). */
  indeterminate?: boolean
  label?: ReactNode
  description?: ReactNode
}

/**
 * Checkbox built on a native input (form + keyboard friendly).
 * @example <Checkbox checked={agree} onCheckedChange={setAgree} label="Also add to VS Code" />
 */
export function Checkbox({ checked, onCheckedChange, indeterminate = false, label, description, className, id, disabled, ...props }: CheckboxProps) {
  const autoId = useId()
  const inputId = id ?? `checkbox-${autoId}`
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate
  }, [indeterminate])

  const on = checked || indeterminate
  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <span className="relative mt-0.5 grid size-4 shrink-0 place-items-center">
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={description ? `${inputId}-desc` : undefined}
          onChange={(e) => onCheckedChange?.(e.target.checked)}
          className="peer absolute inset-0 m-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
          {...props}
        />
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none size-4 rounded-[5px] border shadow-xs transition-colors duration-150',
            'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring',
            on ? 'border-accent-solid bg-accent-solid' : 'border-line-strong bg-surface',
            disabled && 'opacity-50'
          )}
        />
        {indeterminate ? (
          <Minus className="pointer-events-none absolute size-3 text-accent-fg" strokeWidth={3} aria-hidden="true" />
        ) : checked ? (
          <Check className="pointer-events-none absolute size-3 text-accent-fg" strokeWidth={3} aria-hidden="true" />
        ) : null}
      </span>
      {label || description ? (
        <div className="min-w-0">
          {label ? (
            <label
              htmlFor={inputId}
              className={cn('text-sm leading-5 text-fg select-none', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}
            >
              {label}
            </label>
          ) : null}
          {description ? (
            <p id={`${inputId}-desc`} className="text-[13px] leading-5 text-fg-muted">
              {description}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
