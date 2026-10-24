import { createContext, useContext, useId, type ReactNode } from 'react'
import { CircleAlert } from 'lucide-react'
import { cn } from '../../lib/cn'

interface FieldContextValue {
  id: string
  describedBy: string | undefined
  invalid: boolean
  required: boolean
}

const FieldContext = createContext<FieldContextValue | null>(null)

export interface FieldProps {
  /** Visible label. Keep it short and plain ("API key", not "ANTHROPIC_AUTH_TOKEN"). */
  label: ReactNode
  /** Helper text under the control. Hidden while an error is shown. */
  hint?: ReactNode
  /** Error message; marks the control invalid. */
  error?: ReactNode
  required?: boolean
  /** Shows a quiet "Optional" tag next to the label. */
  optional?: boolean
  /** Extra element on the label row's right side (e.g. an ExternalLink "Get a key"). */
  labelAction?: ReactNode
  /** Override the generated control id. */
  id?: string
  className?: string
  children: ReactNode
}

/**
 * Label + control + hint/error, wired for accessibility. Input, Textarea, SecretInput and Select
 * placed inside pick up the id, aria-describedby and aria-invalid automatically.
 * @example
 * <Field label="API key" hint="Starts with sk-" error={error} required>
 *   <SecretInput value={key} onValueChange={setKey} />
 * </Field>
 */
export function Field({ label, hint, error, required = false, optional, labelAction, id, className, children }: FieldProps) {
  const autoId = useId()
  const controlId = id ?? `field-${autoId}`
  const hintId = `${controlId}-hint`
  const errorId = `${controlId}-error`
  const hasError = error !== undefined && error !== null && error !== false && error !== ''
  const describedBy = hasError ? errorId : hint ? hintId : undefined

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex min-h-5 items-baseline justify-between gap-3">
        <label htmlFor={controlId} className="text-[13px] leading-5 font-medium text-fg">
          {label}
          {required ? (
            <span className="ml-0.5 text-danger-text" aria-hidden="true">
              *
            </span>
          ) : null}
          {required ? <span className="sr-only"> (required)</span> : null}
          {optional && !required ? <span className="ml-2 text-xs font-normal text-fg-subtle">Optional</span> : null}
        </label>
        {labelAction ? <div className="shrink-0 text-[13px]">{labelAction}</div> : null}
      </div>
      <FieldContext.Provider value={{ id: controlId, describedBy, invalid: hasError, required }}>{children}</FieldContext.Provider>
      {hasError ? (
        <p id={errorId} className="flex items-start gap-1.5 text-[12.5px] leading-5 text-danger-text" role="alert">
          <CircleAlert className="mt-[3px] size-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p id={hintId} className="text-[12.5px] leading-5 text-fg-muted">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

interface ControlA11yProps {
  id?: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling'
  required?: boolean
}

/**
 * Merge Field context (id, describedby, invalid, required) into a control's props.
 * Explicit props always win. Used by Input, Textarea, SecretInput, Select.
 */
export function useFieldControl<P extends ControlA11yProps>(props: P & { invalid?: boolean }): P {
  const field = useContext(FieldContext)
  const { invalid, ...rest } = props
  const out = { ...rest } as P
  if (field) {
    out.id = props.id ?? field.id
    const describedBy = [props['aria-describedby'], field.describedBy].filter(Boolean).join(' ')
    if (describedBy) out['aria-describedby'] = describedBy
    if (props.required === undefined && field.required) out.required = true
  }
  const isInvalid = invalid ?? field?.invalid ?? false
  if (isInvalid && props['aria-invalid'] === undefined) out['aria-invalid'] = true
  return out
}
