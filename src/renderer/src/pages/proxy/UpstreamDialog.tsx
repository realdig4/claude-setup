import { useMemo, useState, type FormEvent } from 'react'
import { Server } from 'lucide-react'
import type { ProviderPreset, ProxyUpstream } from '@shared/types'
import {
  Button,
  Callout,
  Checkbox,
  Dialog,
  Disclosure,
  Field,
  Input,
  SecretInput,
  Select,
  Separator,
  Switch,
  Textarea,
  toast
} from '@renderer/components/ui'
import { core, errorMessage } from '@renderer/lib/api'
import { KeyValueEditor } from '../models/KeyValueEditor'
import { recordFromRows, rowErrors, rowsFromRecord, type KeyValueRow } from '../models/keyValueRows'
import {
  UPSTREAM_HINTS,
  baseUrlError,
  headerError,
  maxTokensError,
  parseExtraBody,
  parseModelList,
  slugId,
  upstreamFromPreset,
  upstreamIdError,
  upstreamKeyRef
} from './logic'

type Reasoning = NonNullable<ProxyUpstream['reasoning']>
type Effort = NonNullable<ProxyUpstream['maxEffort']>

const REASONING: Array<{ value: Reasoning; label: string }> = [
  { value: 'off', label: 'Off — don’t send reasoning settings' },
  { value: 'effort', label: 'Effort — map Claude’s effort to reasoning_effort' },
  { value: 'roundtrip', label: 'Round-trip — send thinking back (reasoning_content)' },
  { value: 'both', label: 'Both' }
]

const EFFORTS: readonly Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export interface UpstreamDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Edit this upstream (otherwise a new one is created). */
  upstream?: ProxyUpstream
  /** Ids of the other upstreams (must stay unique). */
  takenIds: string[]
  /** OpenAI-style provider presets to start from. */
  presets: ProviderPreset[]
  /** A key is already saved for this upstream. */
  hasKey: boolean
  /** Name of the model setup this upstream belongs to, if any. */
  managedBy?: string
  onSave: (upstream: ProxyUpstream, previousId?: string) => void
}

interface FormState {
  presetId: string
  name: string
  id: string
  idTouched: boolean
  baseUrl: string
  apiKey: string
  removeKey: boolean
  models: string
  maxTokens: string
  reasoning: Reasoning | ''
  maxEffort: Effort | ''
  useMaxCompletionTokens: boolean
  streamOptions: boolean
  headers: KeyValueRow[]
  extraBody: string
}

function formFrom(upstream: ProxyUpstream | undefined): FormState {
  return {
    presetId: upstream?.providerId ?? '',
    name: upstream?.name ?? '',
    id: upstream?.id ?? '',
    idTouched: !!upstream,
    baseUrl: upstream?.baseUrl ?? '',
    apiKey: '',
    removeKey: false,
    models: (upstream?.models ?? []).join('\n'),
    maxTokens: upstream?.maxOutputTokens ? String(upstream.maxOutputTokens) : '',
    reasoning: upstream?.reasoning ?? '',
    maxEffort: upstream?.maxEffort ?? '',
    useMaxCompletionTokens: upstream?.useMaxCompletionTokens ?? false,
    streamOptions: upstream?.streamOptions !== false,
    headers: rowsFromRecord(upstream?.extraHeaders),
    extraBody: upstream?.extraBody ? JSON.stringify(upstream.extraBody, null, 2) : ''
  }
}

/** Add or edit one upstream: an OpenAI-style server the proxy forwards requests to. */
export function UpstreamDialog({ open, onOpenChange, upstream, takenIds, presets, hasKey, managedBy, onSave }: UpstreamDialogProps) {
  const [form, setForm] = useState<FormState>(() => formFrom(upstream))
  const [attempted, setAttempted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const patch = (changes: Partial<FormState>): void => setForm((f) => ({ ...f, ...changes }))

  const extra = parseExtraBody(form.extraBody)
  const headerProblems = rowErrors(form.headers, headerError, { caseInsensitive: true, noun: 'header' })
  const errors = useMemo(() => {
    const out: Partial<Record<'name' | 'id' | 'baseUrl' | 'maxTokens' | 'extraBody', string>> = {}
    if (!form.name.trim() && !form.id.trim()) out.name = 'Give this upstream a name.'
    const idProblem = upstreamIdError(form.id)
    if (idProblem) out.id = idProblem
    else if (takenIds.some((t) => t.toLowerCase() === form.id.trim().toLowerCase())) out.id = 'Another upstream already uses this id.'
    const urlProblem = baseUrlError(form.baseUrl)
    if (urlProblem) out.baseUrl = urlProblem
    const tokens = maxTokensError(form.maxTokens)
    if (tokens) out.maxTokens = tokens
    if (extra.error) out.extraBody = extra.error
    return out
  }, [form, takenIds, extra])
  const valid = Object.keys(errors).length === 0 && Object.keys(headerProblems).length === 0
  const modelCount = parseModelList(form.models).length
  const shown = attempted ? errors : {}

  const choosePreset = (presetId: string): void => {
    const preset = presets.find((p) => p.id === presetId)
    if (!preset) {
      patch({ presetId: '' })
      return
    }
    const next = upstreamFromPreset(preset, takenIds)
    const hints = UPSTREAM_HINTS[preset.id] ?? {}
    setForm((f) => ({
      ...f,
      presetId,
      name: next.name,
      id: f.idTouched && f.id ? f.id : next.id,
      baseUrl: next.baseUrl,
      models: next.models.join('\n'),
      maxTokens: hints.maxOutputTokens ? String(hints.maxOutputTokens) : f.maxTokens,
      reasoning: hints.reasoning ?? f.reasoning,
      useMaxCompletionTokens: hints.useMaxCompletionTokens ?? f.useMaxCompletionTokens,
      streamOptions: hints.streamOptions !== false
    }))
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setAttempted(true)
    if (!valid) return
    setSaving(true)
    setError(null)
    const id = form.id.trim()
    const base: ProxyUpstream = { ...(upstream ?? { id, name: '', baseUrl: '', models: [] }) }
    const ref = upstreamKeyRef({ id, keyRef: upstream?.keyRef })
    try {
      const key = form.apiKey.trim()
      if (key) {
        const result = await core.app.setSecret(ref, key)
        if (!result.ok) throw new Error(result.details ? `${result.message} ${result.details}` : result.message)
      } else if (form.removeKey && hasKey) {
        const result = await core.app.setSecret(ref, null)
        if (!result.ok) throw new Error(result.message)
      }
    } catch (err) {
      setError(errorMessage(err))
      setSaving(false)
      return
    }

    const next: ProxyUpstream = {
      ...base,
      id,
      name: form.name.trim() || id,
      baseUrl: form.baseUrl.trim(),
      models: parseModelList(form.models)
    }
    if (form.presetId) next.providerId = form.presetId
    const keepsKey = !!form.apiKey.trim() || (hasKey && !form.removeKey)
    if (keepsKey) next.keyRef = ref
    else delete next.keyRef
    if (form.maxTokens.trim()) next.maxOutputTokens = Number(form.maxTokens.trim())
    else delete next.maxOutputTokens
    if (form.reasoning) next.reasoning = form.reasoning
    else delete next.reasoning
    if (form.maxEffort) next.maxEffort = form.maxEffort
    else delete next.maxEffort
    if (form.useMaxCompletionTokens) next.useMaxCompletionTokens = true
    else delete next.useMaxCompletionTokens
    if (form.streamOptions) delete next.streamOptions
    else next.streamOptions = false
    const headers = recordFromRows(form.headers)
    if (Object.keys(headers).length) next.extraHeaders = headers
    else delete next.extraHeaders
    if (extra.value) next.extraBody = extra.value
    else delete next.extraBody

    setSaving(false)
    onSave(next, upstream?.id)
    onOpenChange(false)
    if (form.apiKey.trim()) toast.success('Key saved securely', { description: 'It’s used for requests to this upstream only.' })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !saving && onOpenChange(next)}
      size="lg"
      icon={Server}
      title={upstream ? `Edit ${upstream.name || upstream.id}` : 'Add an upstream'}
      description="An OpenAI-style server the proxy forwards Claude Code’s requests to."
      dismissible={!saving}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="upstream-form" loading={saving}>
            {upstream ? 'Save upstream' : 'Add upstream'}
          </Button>
        </>
      }
    >
      <form id="upstream-form" className="flex flex-col gap-5" onSubmit={(e) => void submit(e)} noValidate>
        {error ? (
          <Callout tone="danger" title="Couldn’t save the key" role="alert">
            {error}
          </Callout>
        ) : null}
        {managedBy ? (
          <Callout tone="info" title={`Created by the model setup “${managedBy}”`}>
            Using that setup again rewrites this upstream’s address and models.
          </Callout>
        ) : null}

        {!upstream && presets.length ? (
          <Field label="Start from a provider" optional hint="Fills in the address, models and recommended settings.">
            <Select
              value={form.presetId}
              onValueChange={choosePreset}
              options={[
                { value: '', label: 'Other OpenAI-compatible server' },
                ...presets.map((p) => ({ value: p.id, label: p.name }))
              ]}
            />
          </Field>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={shown.name} required>
            <Input
              value={form.name}
              onValueChange={(name) => patch({ name, id: form.idTouched ? form.id : slugId(name, takenIds) })}
              placeholder="Groq"
              data-autofocus
            />
          </Field>
          <Field label="ID" error={shown.id} hint="Used in routes, e.g. groq/model-name." required>
            <Input mono value={form.id} onValueChange={(id) => patch({ id, idTouched: true })} placeholder="groq" spellCheck={false} />
          </Field>
        </div>

        <Field
          label="Base address"
          error={shown.baseUrl}
          required
          hint="The OpenAI-style address including /v1, for example https://api.groq.com/openai/v1."
        >
          <Input
            mono
            value={form.baseUrl}
            onValueChange={(baseUrl) => patch({ baseUrl })}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
          />
        </Field>

        <Field
          label={hasKey ? 'New API key' : 'API key'}
          optional
          hint={
            hasKey ? 'A key is saved. Leave this empty to keep it.' : 'Stored in your system’s secure storage and sent only to this server.'
          }
        >
          <SecretInput
            value={form.apiKey}
            onValueChange={(apiKey) => patch({ apiKey, removeKey: false })}
            placeholder={hasKey ? '••••••••  (saved)' : 'sk-…'}
          />
        </Field>
        {hasKey ? (
          <Checkbox
            checked={form.removeKey}
            onCheckedChange={(removeKey) => patch({ removeKey, apiKey: '' })}
            label="Remove the saved key"
            description="For servers that don’t need one."
          />
        ) : null}

        <Field
          label="Models"
          hint={`One per line. ${modelCount || 'No'} ${modelCount === 1 ? 'model' : 'models'} — routes can point to these.`}
        >
          <Textarea
            mono
            rows={4}
            value={form.models}
            onValueChange={(models) => patch({ models })}
            placeholder={'gpt-oss-120b\ngpt-oss-20b'}
          />
        </Field>

        <Disclosure
          title="Translation settings"
          description="Output limit, reasoning, headers"
          variant="card"
          defaultOpen={!!upstream}
        >
          <div className="flex flex-col gap-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Max output tokens" optional error={shown.maxTokens} hint="Requests are capped at the provider’s limit.">
                <Input
                  mono
                  inputMode="numeric"
                  value={form.maxTokens}
                  onValueChange={(maxTokens) => patch({ maxTokens })}
                  placeholder="32768"
                />
              </Field>
              <Field label="Strongest reasoning effort" optional hint="Sent when Claude asks for xhigh/max (default high).">
                <Select
                  value={form.maxEffort}
                  onValueChange={(v) => patch({ maxEffort: v as Effort | '' })}
                  options={[{ value: '', label: 'Default (high)' }, ...EFFORTS.map((e) => ({ value: e, label: e }))]}
                />
              </Field>
            </div>
            <Field label="Reasoning" optional>
              <Select
                value={form.reasoning}
                onValueChange={(v) => patch({ reasoning: v as Reasoning | '' })}
                options={[{ value: '', label: 'Default (off)' }, ...REASONING.map((r) => ({ value: r.value, label: r.label }))]}
              />
            </Field>
            <Separator />
            <Switch
              checked={form.useMaxCompletionTokens}
              onCheckedChange={(useMaxCompletionTokens) => patch({ useMaxCompletionTokens })}
              label="Send max_completion_tokens"
              description="Needed by OpenAI’s reasoning models instead of max_tokens."
            />
            <Switch
              checked={form.streamOptions}
              onCheckedChange={(streamOptions) => patch({ streamOptions })}
              label="Ask for token usage while streaming"
              description="Sends stream_options. Turn off for servers that reject it."
            />
            <Separator />
            <div className="flex flex-col gap-2">
              <span className="text-[13px] font-medium text-fg">Extra headers</span>
              <KeyValueEditor
                label="Extra headers"
                rows={form.headers}
                onChange={(headers) => patch({ headers })}
                errors={attempted ? headerProblems : {}}
                keyLabel="Header"
                valueLabel="Value"
                keyPlaceholder="X-Header"
                addLabel="Add header"
              />
            </div>
            <Field
              label="Extra request fields"
              optional
              error={shown.extraBody}
              hint={'A JSON object merged into every request, e.g. {"temperature": 0.2}.'}
            >
              <Textarea mono rows={3} value={form.extraBody} onValueChange={(extraBody) => patch({ extraBody })} placeholder="{}" />
            </Field>
          </div>
        </Disclosure>
      </form>
    </Dialog>
  )
}
