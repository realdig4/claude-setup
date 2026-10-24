import { useRef } from 'react'
import { CircleAlert, Plus, X } from 'lucide-react'
import { Button, Input } from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'
import { newRow, type KeyValueRow } from './keyValueRows'

export interface KeyValueEditorProps {
  rows: KeyValueRow[]
  onChange: (rows: KeyValueRow[]) => void
  /** Accessible name of the whole editor, e.g. "Extra environment variables". */
  label: string
  /** Error messages by row id. */
  errors?: Record<string, string>
  keyLabel?: string
  valueLabel?: string
  keyPlaceholder?: string
  valuePlaceholder?: string
  addLabel?: string
  /** Shown when there are no rows. */
  emptyText?: string
  disabled?: boolean
  className?: string
}

/**
 * Editable list of name/value pairs (environment variables, HTTP headers) with add/remove buttons and inline errors.
 * @example <KeyValueEditor label="Extra environment variables" rows={rows} onChange={setRows} errors={errors} />
 */
export function KeyValueEditor({
  rows,
  onChange,
  label,
  errors = {},
  keyLabel = 'Name',
  valueLabel = 'Value',
  keyPlaceholder = 'NAME',
  valuePlaceholder = 'value',
  addLabel = 'Add',
  emptyText,
  disabled,
  className
}: KeyValueEditorProps) {
  const listRef = useRef<HTMLDivElement>(null)

  const update = (id: string, patch: Partial<KeyValueRow>): void => {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  const remove = (index: number): void => {
    const next = rows.filter((_, i) => i !== index)
    onChange(next)
    // Keep keyboard users in the list: focus the row that took this one's place (or the add button).
    window.requestAnimationFrame(() => {
      const inputs = listRef.current?.querySelectorAll<HTMLInputElement>('input[data-kv="key"]')
      const target = inputs?.[Math.min(index, (inputs?.length ?? 1) - 1)]
      if (target) target.focus()
      else listRef.current?.parentElement?.querySelector<HTMLButtonElement>('button[data-kv="add"]')?.focus()
    })
  }

  const add = (): void => {
    onChange([...rows, newRow()])
    window.requestAnimationFrame(() => {
      const inputs = listRef.current?.querySelectorAll<HTMLInputElement>('input[data-kv="key"]')
      inputs?.[inputs.length - 1]?.focus()
    })
  }

  return (
    <div role="group" aria-label={label} className={cn('flex flex-col gap-2', className)}>
      {rows.length > 0 ? (
        <div
          className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_2rem] gap-x-2 px-0.5 text-xs font-medium text-fg-muted"
          aria-hidden="true"
        >
          <span>{keyLabel}</span>
          <span>{valueLabel}</span>
          <span />
        </div>
      ) : emptyText ? (
        <p className="text-[13px] text-fg-subtle">{emptyText}</p>
      ) : null}
      <div ref={listRef} className="flex flex-col gap-2">
        {rows.map((row, index) => {
          const error = errors[row.id]
          const errorId = error ? `${row.id}-error` : undefined
          return (
            <div key={row.id} className="flex flex-col gap-1">
              <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_2rem] items-center gap-x-2">
                <Input
                  size="sm"
                  mono
                  data-kv="key"
                  value={row.key}
                  onValueChange={(key) => update(row.id, { key })}
                  placeholder={keyPlaceholder}
                  aria-label={`${keyLabel} ${index + 1}`}
                  aria-describedby={errorId}
                  invalid={!!error}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={disabled}
                />
                <Input
                  size="sm"
                  mono
                  value={row.value}
                  onValueChange={(value) => update(row.id, { value })}
                  placeholder={valuePlaceholder}
                  aria-label={`${valueLabel} ${index + 1}`}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={disabled}
                />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${row.key.trim() || `row ${index + 1}`}`}
                  onClick={() => remove(index)}
                  disabled={disabled}
                >
                  <X />
                </Button>
              </div>
              {error ? (
                <p id={errorId} className="flex items-start gap-1.5 text-[12.5px] leading-5 text-danger-text" role="alert">
                  <CircleAlert className="mt-[3px] size-3.5 shrink-0" aria-hidden="true" />
                  <span>{error}</span>
                </p>
              ) : null}
            </div>
          )
        })}
      </div>
      <div>
        <Button size="sm" variant="ghost" leftIcon={Plus} onClick={add} disabled={disabled} data-kv="add" className="-ml-2">
          {addLabel}
        </Button>
      </div>
    </div>
  )
}
