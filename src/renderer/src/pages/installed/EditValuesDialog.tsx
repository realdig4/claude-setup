/** Simple mode: change a tool's keys and other values (environment variables or headers) without seeing any JSON. */
import { useEffect, useMemo, useState } from 'react'
import { KeyRound } from 'lucide-react'
import type { InstalledServer } from '@shared/types'
import { Button, Dialog, Field, Input, SecretInput, toastError, toastResult } from '@renderer/components/ui'
import { core } from '@renderer/lib/api'
import { humanizeName } from '../discover/lib/installForm'
import { TARGET_NAMES } from '../discover/lib/targets'
import { noteRestart } from '../discover/common/restart'
import { bumpServers } from '../discover/common/servers'
import { editableValues, withValues } from './lib/tools'

export interface EditValuesDialogProps {
  server: InstalledServer | null
  label: string
  onClose: () => void
}

function labelFor(kind: 'env' | 'header', name: string): string {
  return kind === 'header' && name.toLowerCase() === 'authorization' ? 'Access token' : humanizeName(name)
}

/** Friendly editor for env / header values. */
export function EditValuesDialog({ server, label, onClose }: EditValuesDialogProps) {
  const fields = useMemo(() => (server ? editableValues(server.config) : []), [server])
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setValues(Object.fromEntries(fields.map((f) => [f.name, f.value])))
  }, [fields])

  const changed = fields.some((f) => (values[f.name] ?? '') !== f.value)

  const save = async (): Promise<void> => {
    if (!server) return
    setSaving(true)
    try {
      const trimmed = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]))
      const result = await core.servers.update(server.name, server.target, withValues(server.config, trimmed))
      toastResult(result, result.ok ? { successTitle: `Updated ${label}` } : { errorTitle: `Couldn’t update ${label}` })
      if (result.ok) {
        noteRestart(result)
        bumpServers()
        onClose()
      }
    } catch (err) {
      toastError(err, `Couldn’t update ${label}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={!!server}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      icon={KeyRound}
      title={`Change ${label} settings`}
      description={server ? `Used by ${TARGET_NAMES[server.target.target]}. A backup is made before saving.` : undefined}
      dismissible={!saving}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!changed} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (changed) void save()
        }}
      >
        {fields.map((field, i) => (
          <Field key={field.name} label={labelFor(field.kind, field.name)}>
            {field.secret ? (
              <SecretInput
                value={values[field.name] ?? ''}
                onValueChange={(v) => setValues((prev) => ({ ...prev, [field.name]: v }))}
                data-autofocus={i === 0 ? true : undefined}
              />
            ) : (
              <Input
                value={values[field.name] ?? ''}
                onValueChange={(v) => setValues((prev) => ({ ...prev, [field.name]: v }))}
                spellCheck={false}
                data-autofocus={i === 0 ? true : undefined}
              />
            )}
          </Field>
        ))}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  )
}
