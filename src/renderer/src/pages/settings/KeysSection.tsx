import { useEffect, useState, type FormEvent } from 'react'
import { Check } from 'lucide-react'
import type { AppSettings } from '@shared/types'
import {
  AdvancedOnly,
  Badge,
  Button,
  ExternalLink,
  Field,
  Input,
  SecretInput,
  Skeleton,
  confirmAction,
  toast,
  toastError,
  toastResult
} from '@renderer/components/ui'
import { core } from '@renderer/lib/api'
import { useAsync } from '@renderer/lib/hooks'
import { KEY_META, SOURCE_META, keyRef, type KeyMeta } from './meta'

export interface KeysSectionProps {
  settings: AppSettings
  update: (patch: Partial<AppSettings>) => Promise<boolean>
}

function TenantField({ settings, update }: KeysSectionProps) {
  const [value, setValue] = useState(settings.pulsemcpTenantId ?? '')
  useEffect(() => setValue(settings.pulsemcpTenantId ?? ''), [settings.pulsemcpTenantId])
  const commit = (): void => {
    const next = value.trim()
    if (next !== (settings.pulsemcpTenantId ?? '')) void update({ pulsemcpTenantId: next })
  }
  return (
    <Field label="Tenant ID" optional hint="Sent with your PulseMCP key. Saved when you leave the field.">
      <Input
        mono
        size="sm"
        value={value}
        onValueChange={setValue}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        placeholder="your-tenant-id"
        autoComplete="off"
        spellCheck={false}
      />
    </Field>
  )
}

function KeyRow({ meta, settings, update }: KeysSectionProps & { meta: KeyMeta }) {
  const ref = keyRef(settings, meta)
  const stored = useAsync(() => core.app.hasSecret(ref), [ref])
  const [value, setValue] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null)
  const configured = !!settings[meta.settingsKey] && stored.data === true
  const showForm = !configured || editing

  const save = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    const secret = value.trim()
    if (!secret) return
    setBusy('save')
    try {
      const result = await core.app.setSecret(ref, secret)
      if (!result.ok) {
        toastResult(result)
        return
      }
      const patch: Partial<AppSettings> = {}
      if (settings[meta.settingsKey] !== ref) patch[meta.settingsKey] = ref
      const turnOn = !!meta.source && !settings.sources[meta.source]
      if (meta.source && turnOn) patch.sources = { ...settings.sources, [meta.source]: true }
      if (Object.keys(patch).length) await update(patch)
      setValue('')
      setEditing(false)
      stored.setData(true)
      toast.success(`${meta.title} saved`, {
        description: meta.source && turnOn ? `${SOURCE_META[meta.source].label} is now on in Discover.` : result.message
      })
    } catch (err) {
      toastError(err, `Couldn’t save the ${meta.title}`)
    } finally {
      setBusy(null)
    }
  }

  const remove = async (): Promise<void> => {
    const ok = await confirmAction({
      title: `Remove the ${meta.title}?`,
      description: meta.source
        ? `${SOURCE_META[meta.source].label} is turned off until you add a key again.`
        : 'It’s deleted from this computer. You can add it again any time.',
      tone: 'danger',
      confirmLabel: 'Remove'
    })
    if (!ok) return
    setBusy('remove')
    try {
      const result = await core.app.setSecret(ref, null)
      if (!result.ok) {
        toastResult(result)
        return
      }
      const patch: Partial<AppSettings> = {}
      patch[meta.settingsKey] = ''
      if (meta.source && settings.sources[meta.source]) patch.sources = { ...settings.sources, [meta.source]: false }
      await update(patch)
      stored.setData(false)
      toast.success(`${meta.title} removed`)
    } catch (err) {
      toastError(err, `Couldn’t remove the ${meta.title}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <li className="flex flex-col gap-3 px-4 py-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg">{meta.title}</span>
            {stored.loading && stored.data === undefined ? (
              <Skeleton className="h-5 w-14 rounded-md" />
            ) : configured ? (
              <Badge size="sm" tone="success" icon={Check}>
                Saved
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">
            {meta.description} <ExternalLink href={meta.url}>{meta.urlLabel}</ExternalLink>
          </p>
          <AdvancedOnly>
            <p className="mt-1 font-mono text-[11px] text-fg-subtle">
              {meta.settingsKey} → {ref}
            </p>
          </AdvancedOnly>
        </div>
        {configured && !editing ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button size="sm" onClick={() => setEditing(true)} disabled={!!busy}>
              Replace
            </Button>
            <Button size="sm" variant="ghost" loading={busy === 'remove'} onClick={() => void remove()}>
              Remove
            </Button>
          </div>
        ) : null}
      </div>
      {showForm ? (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => void save(e)}>
          <SecretInput
            size="sm"
            value={value}
            onValueChange={setValue}
            placeholder={meta.placeholder}
            aria-label={meta.title}
            containerClassName="min-w-60 flex-1"
            disabled={busy === 'save'}
          />
          <Button type="submit" size="sm" loading={busy === 'save'} disabled={!value.trim()}>
            Save key
          </Button>
          {editing ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false)
                setValue('')
              }}
            >
              Cancel
            </Button>
          ) : null}
        </form>
      ) : null}
      {meta.id === 'pulsemcp' ? <TenantField settings={settings} update={update} /> : null}
    </li>
  )
}

/** Optional API keys (GitHub, Smithery, Glama, PulseMCP), stored in the system's secure storage. */
export function KeysSection({ settings, update }: KeysSectionProps) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-xs" aria-label="Optional keys">
      {KEY_META.map((meta) => (
        <KeyRow key={meta.id} meta={meta} settings={settings} update={update} />
      ))}
    </ul>
  )
}
