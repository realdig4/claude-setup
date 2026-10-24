import { Fragment, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../lib/cn'

export interface StepItem {
  id: string
  label: ReactNode
  description?: ReactNode
}

export interface StepperProps {
  steps: ReadonlyArray<StepItem>
  /** Index of the current step (0-based). Steps before it are shown as done. */
  current: number
  /** Allow jumping back to completed steps. */
  onStepClick?: (index: number) => void
  orientation?: 'horizontal' | 'vertical'
  className?: string
}

/**
 * Progress through a wizard ("Choose apps → Settings → Done").
 * @example <Stepper steps={[{ id: 'apps', label: 'Choose apps' }, { id: 'setup', label: 'Set up' }, { id: 'done', label: 'Done' }]} current={1} />
 */
export function Stepper({ steps, current, onStepClick, orientation = 'horizontal', className }: StepperProps) {
  const vertical = orientation === 'vertical'
  return (
    <ol
      aria-label="Progress"
      className={cn(vertical ? 'flex flex-col gap-0' : 'flex w-full items-center gap-2', className)}
    >
      {steps.map((step, index) => {
        const state = index < current ? 'done' : index === current ? 'current' : 'upcoming'
        const clickable = !!onStepClick && state === 'done'
        const marker = (
          <span
            className={cn(
              'relative grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold transition-colors duration-200',
              state === 'done' && 'bg-accent-solid text-accent-fg',
              state === 'current' && 'bg-surface text-accent-text ring-2 ring-accent ring-offset-2 ring-offset-canvas',
              state === 'upcoming' && 'bg-surface-3 text-fg-subtle'
            )}
          >
            {state === 'done' ? <Check className="size-3.5" strokeWidth={3} aria-hidden="true" /> : index + 1}
          </span>
        )
        const text = (
          <span className="min-w-0 text-left">
            <span
              className={cn(
                'block truncate text-[13px] leading-5 font-medium',
                state === 'upcoming' ? 'text-fg-subtle' : 'text-fg'
              )}
            >
              {step.label}
            </span>
            {step.description ? <span className="block text-xs leading-4 text-fg-muted">{step.description}</span> : null}
          </span>
        )
        const content = clickable ? (
          <button
            type="button"
            onClick={() => onStepClick(index)}
            className="flex min-w-0 items-center gap-2.5 rounded-lg p-0.5 pr-2 transition-colors hover:bg-surface-2"
          >
            {marker}
            {text}
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-2.5 p-0.5 pr-2">
            {marker}
            {text}
          </span>
        )
        return (
          <Fragment key={step.id}>
            <li aria-current={state === 'current' ? 'step' : undefined} className={cn('flex min-w-0', !vertical && 'shrink-0')}>
              {content}
              <span className="sr-only">{state === 'done' ? ' (completed)' : state === 'current' ? ' (current step)' : ''}</span>
            </li>
            {index < steps.length - 1 ? (
              <li
                aria-hidden="true"
                className={cn(
                  'relative overflow-hidden rounded-full bg-line',
                  vertical ? 'my-1 ml-[15px] h-5 w-0.5' : 'h-0.5 min-w-6 flex-1'
                )}
              >
                <span
                  className={cn(
                    'absolute inset-0 origin-left bg-accent transition-transform duration-500 ease-smooth',
                    vertical && 'origin-top',
                    index < current ? 'scale-100' : vertical ? 'scale-y-0' : 'scale-x-0'
                  )}
                />
              </li>
            ) : null}
          </Fragment>
        )
      })}
    </ol>
  )
}
