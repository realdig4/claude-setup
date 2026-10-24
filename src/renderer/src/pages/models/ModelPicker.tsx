import { useId, useMemo, useRef, useState } from 'react'
import { List } from 'lucide-react'
import type { ModelPreset } from '@shared/types'
import { Input, Select, type SelectOption } from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'
import { formatTokens } from '@renderer/lib/format'
import { findModel, isRetiring } from './logic'

const CUSTOM = '__custom__'

export interface ModelPickerProps {
  value: string
  onChange: (value: string) => void
  /** Known models (preset + loaded from the provider). */
  options: readonly ModelPreset[]
  /** Label of an empty choice (e.g. "Same as the main model"); without it a model is required. */
  emptyLabel?: string
  placeholder?: string
  size?: 'sm' | 'md' | 'lg'
  disabled?: boolean
  invalid?: boolean
  'aria-label'?: string
}

function optionLabel(model: ModelPreset): string {
  const parts = [model.label]
  const size = model.context ? formatTokens(model.context) : ''
  if (size && !model.label.includes(size)) parts.push(size)
  if (isRetiring(model)) parts.push('retiring')
  return parts.join(' · ')
}

/**
 * Pick a model from the provider's list, or type any model name ("Type a model name…" switches to a text field with
 * suggestions). Works inside a Field (label/hint/error wiring).
 */
export function ModelPicker(props: ModelPickerProps) {
  const { value, onChange, options, emptyLabel, placeholder, size = 'md', disabled, invalid, 'aria-label': ariaLabel } = props
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const known = !!findModel(options, value) || (value === '' && (options.length > 0 || !!emptyLabel))
  const [typing, setTyping] = useState(() => options.length === 0 || (!known && value !== ''))
  const showInput = typing || options.length === 0

  const selectOptions = useMemo<SelectOption[]>(() => {
    const list: SelectOption[] = []
    if (emptyLabel) list.push({ value: '', label: emptyLabel })
    if (value && !findModel(options, value)) list.push({ value, label: value })
    for (const model of options) list.push({ value: model.id, label: optionLabel(model) })
    list.push({ value: CUSTOM, label: 'Type a model name…' })
    return list
  }, [options, value, emptyLabel])

  const selected = findModel(options, value)?.id ?? value

  if (showInput) {
    return (
      <>
        <Input
          ref={inputRef}
          size={size}
          mono
          value={value}
          onValueChange={(next) => onChange(next.trim() === '' ? '' : next)}
          placeholder={placeholder ?? (emptyLabel ? `${emptyLabel}` : 'model-name')}
          list={options.length ? listId : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          invalid={invalid}
          aria-label={ariaLabel}
          rightSlot={
            options.length > 0 ? (
              <button
                type="button"
                onClick={() => setTyping(false)}
                disabled={disabled}
                className={cn(
                  'grid size-7 place-items-center rounded-md text-fg-subtle transition-colors',
                  'hover:bg-surface-3/70 hover:text-fg'
                )}
                aria-label="Choose from the list"
                title="Choose from the list"
              >
                <List className="size-4" aria-hidden="true" />
              </button>
            ) : undefined
          }
        />
        {options.length ? (
          <datalist id={listId}>
            {options.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
              </option>
            ))}
          </datalist>
        ) : null}
      </>
    )
  }

  return (
    <Select
      size={size}
      value={selected}
      options={selectOptions}
      disabled={disabled}
      invalid={invalid}
      aria-label={ariaLabel}
      onValueChange={(next) => {
        if (next === CUSTOM) {
          setTyping(true)
          window.requestAnimationFrame(() => inputRef.current?.focus())
          return
        }
        onChange(next)
      }}
    />
  )
}
