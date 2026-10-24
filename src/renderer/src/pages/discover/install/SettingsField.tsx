/** One generated settings field (key, folder list, file path, switch, number, address or text). */
import type { ReactNode } from 'react'
import { ExternalLink, Field, Input, SecretInput, Switch } from '@renderer/components/ui'
import { FieldGroup, ListEditor, PathInput } from '../common/inputs'
import { isRequired, type FormField } from '../lib/installForm'

export interface SettingsFieldProps {
  field: FormField
  value: string | string[] | undefined
  onChange: (value: string | string[]) => void
  error?: string
  advanced: boolean
}

function text(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

/** Renders the right control for a FormField, with its label, hint and error. */
export function SettingsField({ field, value, onChange, error, advanced }: SettingsFieldProps) {
  const required = isRequired(field)
  const label: ReactNode =
    advanced && field.label.toLowerCase() !== field.name.toLowerCase() ? (
      <>
        {field.label}
        <code className="ml-2 rounded-[5px] bg-surface-3/70 px-1.5 py-px font-mono text-[11px] font-normal text-fg-muted">{field.name}</code>
      </>
    ) : (
      field.label
    )
  const hints: string[] = []
  if (field.description) hints.push(field.description)
  if (field.bearer) hints.push('Paste just the token — “Bearer ” is added for you.')
  const hint = hints.length ? hints.join(' ') : undefined
  const labelAction = field.helpUrl ? <ExternalLink href={field.helpUrl}>{field.secret ? 'Get a key' : 'Learn more'}</ExternalLink> : undefined

  if (field.repeatable) {
    const list = Array.isArray(value) ? value : value ? [value] : []
    const folder = field.format === 'directory'
    const file = field.format === 'path'
    return (
      <FieldGroup label={label} hint={hint} error={error} required={required} optional={!required} labelAction={labelAction}>
        <ListEditor
          itemLabel={folder ? 'Folder' : file ? 'File' : field.label}
          values={list}
          onChange={onChange}
          pick={folder ? 'folder' : file ? 'file' : undefined}
          allowTyping={advanced}
          addLabel={folder ? 'Add a folder…' : file ? 'Add a file…' : 'Add another'}
          invalid={!!error}
          emptyText={folder ? 'No folders yet. Claude will only be able to use the folders you add here.' : undefined}
        />
      </FieldGroup>
    )
  }

  if (field.format === 'boolean') {
    return (
      <div className="rounded-xl border border-line bg-surface px-4 py-3">
        <Switch checked={text(value) === 'true'} onCheckedChange={(on) => onChange(on ? 'true' : '')} label={label} description={hint} />
      </div>
    )
  }

  const common = {
    value: text(value),
    onValueChange: (v: string) => onChange(v),
    placeholder: field.placeholder ?? (field.default ? `Default: ${field.default}` : undefined)
  }

  return (
    <Field label={label} hint={hint} error={error} required={required} optional={!required} labelAction={labelAction}>
      {field.format === 'directory' || field.format === 'path' ? (
        <PathInput {...common} pick={field.format === 'directory' ? 'folder' : 'file'} pickTitle={`Choose: ${field.label}`} />
      ) : field.secret ? (
        <SecretInput {...common} />
      ) : field.format === 'number' ? (
        <Input {...common} type="number" inputMode="decimal" className="tabular-nums" />
      ) : field.format === 'url' ? (
        <Input {...common} type="url" mono spellCheck={false} />
      ) : (
        <Input {...common} spellCheck={false} />
      )}
    </Field>
  )
}
