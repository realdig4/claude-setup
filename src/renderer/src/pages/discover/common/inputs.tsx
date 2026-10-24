/**
 * Form building blocks used by the install wizard and My Tools: a labelled group for multi-control fields,
 * a path input with a native picker, a repeatable list editor and a name/value editor.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { CircleAlert, FolderOpen, Plus, X } from 'lucide-react'
import { Button, Input, SecretInput, toast, type InputProps } from '@renderer/components/ui'
import { errorMessage, ui } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { looksSecret } from '../../installed/lib/tools'
import { newRow, type KeyValueRow } from '../lib/customServer'

export interface FieldGroupProps {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  optional?: boolean
  labelAction?: ReactNode
  className?: string
  children: ReactNode
}

/** Like Field, for fields made of several controls (lists, name/value rows): role="group" with a label. */
export function FieldGroup({ label, hint, error, required, optional, labelAction, className, children }: FieldGroupProps) {
  const id = useId()
  const hasError = !!error
  return (
    <div
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={hasError ? `${id}-error` : hint ? `${id}-hint` : undefined}
      className={cn('flex flex-col gap-1.5', className)}
    >
      <div className="flex min-h-5 items-baseline justify-between gap-3">
        <span id={`${id}-label`} className="text-[13px] leading-5 font-medium text-fg">
          {label}
          {required ? (
            <span className="ml-0.5 text-danger-text" aria-hidden="true">
              *
            </span>
          ) : null}
          {required ? <span className="sr-only"> (required)</span> : null}
          {optional && !required ? <span className="ml-2 text-xs font-normal text-fg-subtle">Optional</span> : null}
        </span>
        {labelAction ? <div className="shrink-0 text-[13px]">{labelAction}</div> : null}
      </div>
      {children}
      {hasError ? (
        <p id={`${id}-error`} role="alert" className="flex items-start gap-1.5 text-[12.5px] leading-5 text-danger-text">
          <CircleAlert className="mt-[3px] size-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[12.5px] leading-5 text-fg-muted">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/** Open the native folder / file picker. Resolves null when cancelled or unavailable (with a toast). */
export async function pickPath(kind: 'folder' | 'file', title: string, defaultPath?: string): Promise<string | null> {
  try {
    return kind === 'folder' ? await ui.pickFolder({ title, defaultPath: defaultPath || undefined }) : await ui.pickFile({ title })
  } catch (err) {
    toast.error('Couldn’t open the picker', { description: `${errorMessage(err)} You can type the path instead.` })
    return null
  }
}

export interface PathInputProps extends Omit<InputProps, 'value' | 'onValueChange' | 'onChange'> {
  value: string
  onValueChange: (value: string) => void
  pick: 'folder' | 'file'
  /** Title of the native picker window. */
  pickTitle?: string
}

/** Text field for a path with a "Choose…" button that opens the native picker. */
export function PathInput({ value, onValueChange, pick, pickTitle, className, ...props }: PathInputProps) {
  const browse = async (): Promise<void> => {
    const chosen = await pickPath(pick, pickTitle ?? (pick === 'folder' ? 'Choose a folder' : 'Choose a file'), value)
    if (chosen) onValueChange(chosen)
  }
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Input mono value={value} onValueChange={onValueChange} containerClassName="min-w-0 flex-1" {...props} />
      <Button variant="outline" leftIcon={FolderOpen} onClick={() => void browse()}>
        Choose…
      </Button>
    </div>
  )
}

export interface ListEditorProps {
  /** Name of one item, used for accessible labels ("Folder" → "Folder 2", "Remove folder 2"). */
  itemLabel: string
  values: string[]
  onChange: (values: string[]) => void
  /** Items are paths: adds a picker per row, and "Add" opens the picker. */
  pick?: 'folder' | 'file'
  addLabel: string
  /** With `pick`: also offer an empty row to type a path. */
  allowTyping?: boolean
  placeholder?: string
  mono?: boolean
  invalid?: boolean
  /** Shown when the list is empty. */
  emptyText?: ReactNode
}

/** Editable list of values (folders, arguments) with add / remove. */
export function ListEditor({
  itemLabel,
  values,
  onChange,
  pick,
  addLabel,
  allowTyping,
  placeholder,
  mono = true,
  invalid,
  emptyText
}: ListEditorProps) {
  const inputs = useRef<Array<HTMLInputElement | null>>([])
  const focusIndex = useRef<number | null>(null)
  const lower = itemLabel.toLowerCase()

  useEffect(() => {
    if (focusIndex.current === null) return
    inputs.current[focusIndex.current]?.focus()
    focusIndex.current = null
  }, [values.length])

  const update = (index: number, value: string): void => onChange(values.map((v, i) => (i === index ? value : v)))
  const remove = (index: number): void => {
    onChange(values.filter((_, i) => i !== index))
    focusIndex.current = Math.max(0, Math.min(index, values.length - 2))
  }
  const addEmpty = (): void => {
    focusIndex.current = values.length
    onChange([...values, ''])
  }
  const add = async (): Promise<void> => {
    if (!pick) return addEmpty()
    const chosen = await pickPath(pick, pick === 'folder' ? 'Choose a folder Claude can use' : 'Choose a file')
    if (chosen && !values.includes(chosen)) onChange([...values.filter((v) => v.trim()), chosen])
  }
  const browseRow = async (index: number): Promise<void> => {
    if (!pick) return
    const chosen = await pickPath(pick, pick === 'folder' ? 'Choose a folder' : 'Choose a file', values[index])
    if (chosen) update(index, chosen)
  }

  return (
    <div className="flex flex-col gap-2">
      {values.length === 0 && emptyText ? (
        <div
          className={cn(
            'rounded-lg border border-dashed px-3.5 py-3 text-[13px] text-fg-muted',
            invalid ? 'border-danger-line' : 'border-line-strong/70'
          )}
        >
          {emptyText}
        </div>
      ) : null}
      {values.map((value, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <Input
            ref={(el) => {
              inputs.current[index] = el
            }}
            mono={mono}
            value={value}
            onValueChange={(v) => update(index, v)}
            placeholder={placeholder}
            aria-label={`${itemLabel} ${index + 1}`}
            invalid={invalid && !value.trim()}
            containerClassName="min-w-0 flex-1"
          />
          {pick ? (
            <Button variant="ghost" size="icon" aria-label={`Choose ${lower} ${index + 1}`} title="Choose…" onClick={() => void browseRow(index)}>
              <FolderOpen />
            </Button>
          ) : null}
          <Button variant="ghost" size="icon" aria-label={`Remove ${lower} ${index + 1}`} title="Remove" onClick={() => remove(index)}>
            <X />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" leftIcon={pick === 'folder' ? FolderOpen : Plus} onClick={() => void add()}>
          {addLabel}
        </Button>
        {pick && allowTyping ? (
          <Button variant="ghost" size="sm" leftIcon={Plus} onClick={addEmpty}>
            Type a path
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export interface KeyValueEditorProps {
  rows: KeyValueRow[]
  onChange: (rows: KeyValueRow[]) => void
  /** "Name" / "Header" column label. */
  keyLabel: string
  valueLabel: string
  addLabel: string
  keyPlaceholder?: string
  valuePlaceholder?: string
  invalid?: boolean
}

/** Name → value rows (environment variables, headers). Values that look secret get a hidden input. */
export function KeyValueEditor({ rows, onChange, keyLabel, valueLabel, addLabel, keyPlaceholder, valuePlaceholder, invalid }: KeyValueEditorProps) {
  const keyInputs = useRef<Array<HTMLInputElement | null>>([])
  const focusIndex = useRef<number | null>(null)

  useEffect(() => {
    if (focusIndex.current === null) return
    keyInputs.current[focusIndex.current]?.focus()
    focusIndex.current = null
  }, [rows.length])

  const update = (id: string, patch: Partial<KeyValueRow>): void => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))

  return (
    <div className="flex flex-col gap-2">
      {rows.length ? (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_2.25rem] gap-x-1.5 gap-y-2">
          <span className="px-0.5 text-xs font-medium text-fg-subtle" aria-hidden="true">
            {keyLabel}
          </span>
          <span className="px-0.5 text-xs font-medium text-fg-subtle" aria-hidden="true">
            {valueLabel}
          </span>
          <span aria-hidden="true" />
          {rows.map((row, index) => {
            const secret = looksSecret(row.key)
            const valueProps = {
              value: row.value,
              onValueChange: (value: string) => update(row.id, { value }),
              placeholder: valuePlaceholder,
              'aria-label': `${valueLabel} ${index + 1}${row.key ? ` (${row.key})` : ''}`,
              invalid: invalid && !!row.value.trim() && !row.key.trim()
            }
            return (
              <div key={row.id} className="contents">
                <Input
                  ref={(el) => {
                    keyInputs.current[index] = el
                  }}
                  mono
                  value={row.key}
                  onValueChange={(key) => update(row.id, { key })}
                  placeholder={keyPlaceholder}
                  aria-label={`${keyLabel} ${index + 1}`}
                  invalid={invalid && !row.key.trim() && !!row.value.trim()}
                />
                {secret ? <SecretInput {...valueProps} allowPaste={false} /> : <Input mono {...valueProps} />}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${row.key || `row ${index + 1}`}`}
                  title="Remove"
                  onClick={() => {
                    focusIndex.current = Math.max(0, Math.min(index, rows.length - 2))
                    onChange(rows.filter((r) => r.id !== row.id))
                  }}
                >
                  <X />
                </Button>
              </div>
            )
          })}
        </div>
      ) : null}
      <div>
        <Button
          variant="outline"
          size="sm"
          leftIcon={Plus}
          onClick={() => {
            focusIndex.current = rows.length
            onChange([...rows, newRow()])
          }}
        >
          {addLabel}
        </Button>
      </div>
    </div>
  )
}
