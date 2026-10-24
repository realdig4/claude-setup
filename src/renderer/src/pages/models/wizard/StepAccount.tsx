import { ArrowUpRight, Info, LockKeyhole, MonitorCheck } from 'lucide-react'
import type { ProviderPreset } from '@shared/types'
import {
  Button,
  Callout,
  Disclosure,
  ExternalLink,
  Field,
  Input,
  OptionCard,
  OptionCardGroup,
  SecretInput,
  Select,
  openExternal
} from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'
import { cloudFields, hostOf, isUserDefined, providerNotes } from '../logic'
import { showsKeyField, type AccountErrors, type WizardDraft } from './draft'

export interface StepAccountProps {
  preset: ProviderPreset
  draft: WizardDraft
  onChange: (patch: Partial<WizardDraft>) => void
  /** Errors to show (only after the user tried to continue). */
  errors: AccountErrors
  /** Editing a profile that already has a saved key. */
  hasStoredKey: boolean
  advanced: boolean
}

function StepNumber({ n }: { n: number }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-full bg-accent-soft text-xs font-semibold text-accent-text',
        'ring-1 ring-accent-line/60'
      )}
    >
      {n}
    </span>
  )
}

/** Step 1: get and paste the API key, pick a region, enter a server address or cloud account details. */
export function StepAccount({ preset, draft, onChange, errors, hasStoredKey, advanced }: StepAccountProps) {
  const vendor = preset.vendor && preset.vendor !== 'Custom' ? preset.vendor : preset.name
  const keyHost = hostOf(preset.keyUrl)
  const region = preset.regions.find((r) => r.id === draft.regionId) ?? preset.regions[0]
  const userDefined = isUserDefined(preset)
  const fields = cloudFields(preset)
  const notes = providerNotes(preset)
  const showKey = showsKeyField(preset)
  const keyRequired = preset.requiresKey && !hasStoredKey
  const cloudKeyLabel = preset.keyPlaceholder?.replace(/\s*\(optional\)$/i, '') ?? 'API key'
  const keyLabel = hasStoredKey ? 'New API key' : preset.kind === 'cloud' ? cloudKeyLabel : 'API key'

  const keyHint = hasStoredKey
    ? 'A key is already saved. Leave this empty to keep it.'
    : preset.kind === 'anthropic'
      ? 'Optional. Leave it empty to use your Claude account, or paste an Anthropic API key to pay per use.'
      : preset.kind === 'cloud'
        ? 'Optional. Without a key, Claude Code uses the sign-in from your cloud tools.'
        : preset.requiresKey
          ? `Stored in your system’s secure storage and only sent to ${vendor}.`
          : 'Only if your server needs one.'

  return (
    <div className="flex flex-col gap-6">
      {preset.requiresKey && preset.keyUrl && !hasStoredKey ? (
        <ol className="flex flex-col gap-3" aria-label="How to get a key">
          <li className="flex items-center gap-3">
            <StepNumber n={1} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-fg">Open {vendor}’s website</p>
              <p className="text-[13px] text-fg-muted">Sign in, or create a free account.</p>
            </div>
            <Button size="sm" rightIcon={ArrowUpRight} onClick={() => void openExternal(preset.keyUrl ?? '')}>
              {keyHost ? `Open ${keyHost.replace(/^www\./, '')}` : 'Open website'}
            </Button>
          </li>
          <li className="flex items-center gap-3">
            <StepNumber n={2} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-fg">Create an API key and copy it</p>
              <p className="text-[13px] text-fg-muted">Some sites show the key only once — copy it right away.</p>
            </div>
          </li>
          <li className="flex items-center gap-3">
            <StepNumber n={3} />
            <p className="min-w-0 flex-1 text-sm font-medium text-fg">Paste it below</p>
          </li>
        </ol>
      ) : null}

      {preset.kind === 'local' ? (
        <Callout tone="info" icon={MonitorCheck} title={`Make sure ${preset.name.replace(/\s*\(.*\)$/, '')} is running`}>
          The model runs on this computer, so no key is needed. Start the app first, then continue.
          {preset.docsUrl ? (
            <>
              {' '}
              <ExternalLink href={preset.docsUrl}>Setup guide</ExternalLink>
            </>
          ) : null}
        </Callout>
      ) : null}

      {preset.kind === 'cloud' ? (
        <Callout tone="info" title={`Claude Code signs in with your ${vendor} account`}>
          Sign in with your cloud tools on this computer first, then fill in the details below.
          {preset.docsUrl ? (
            <>
              {' '}
              <ExternalLink href={preset.docsUrl}>Setup guide</ExternalLink>
            </>
          ) : null}
        </Callout>
      ) : null}

      {preset.regions.length > 1 ? (
        preset.regions.length <= 4 ? (
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium text-fg">Where is your account?</span>
            <OptionCardGroup label="Account region" columns={2}>
              {preset.regions.map((r) => (
                <OptionCard
                  key={r.id}
                  title={r.label}
                  description={advanced ? <span className="font-mono text-xs">{hostOf(r.baseUrl)}</span> : undefined}
                  checked={draft.regionId === r.id}
                  onCheckedChange={() => onChange({ regionId: r.id })}
                />
              ))}
            </OptionCardGroup>
            <p className="text-[12.5px] text-fg-muted">Keys only work in the region where they were created.</p>
          </div>
        ) : (
          <Field label="Region" hint="Keys only work in the region where they were created.">
            <Select
              value={draft.regionId}
              onValueChange={(regionId) => onChange({ regionId })}
              options={preset.regions.map((r) => ({ value: r.id, label: r.label }))}
            />
          </Field>
        )
      ) : null}

      {userDefined ? (
        <Field
          label="Server address"
          required
          error={errors.baseUrl}
          hint={
            preset.kind === 'openai-proxy'
              ? 'The OpenAI-style address including /v1, for example http://localhost:8000/v1.'
              : 'The base address without /v1 — Claude Code adds /v1/messages itself.'
          }
        >
          <Input
            mono
            size="lg"
            value={draft.baseUrl}
            onValueChange={(baseUrl) => onChange({ baseUrl })}
            placeholder={preset.kind === 'openai-proxy' ? 'http://localhost:8000/v1' : 'http://localhost:4000'}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      ) : null}

      {fields.map((field) => (
        <Field
          key={field.key}
          label={field.label}
          required={field.required}
          optional={!field.required}
          hint={advanced ? `${field.hint ? `${field.hint} ` : ''}Saved as ${field.key}.` : field.hint}
          error={errors.cloud?.[field.key]}
        >
          <Input
            mono
            value={draft.cloud[field.key] ?? ''}
            onValueChange={(value) => onChange({ cloud: { ...draft.cloud, [field.key]: value } })}
            placeholder={field.placeholder}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      ))}

      {showKey ? (
        <Field
          label={keyLabel}
          required={keyRequired}
          optional={!keyRequired}
          error={errors.apiKey}
          hint={keyHint}
          labelAction={
            preset.keyUrl && (hasStoredKey || !preset.requiresKey) ? <ExternalLink href={preset.keyUrl}>Get a key</ExternalLink> : undefined
          }
        >
          <SecretInput
            size="lg"
            value={draft.apiKey}
            onValueChange={(apiKey) => onChange({ apiKey })}
            placeholder={hasStoredKey ? '••••••••  (saved)' : (preset.keyPlaceholder ?? 'Paste your key')}
          />
        </Field>
      ) : null}

      {advanced && !userDefined && preset.kind !== 'cloud' ? (
        <Disclosure
          title="Use a different address"
          description="For gateways or proxies in front of the provider"
          defaultOpen={!!draft.baseUrl}
        >
          <Field
            label="Custom address"
            optional
            error={errors.baseUrl}
            hint={region?.baseUrl ? `Leave empty to use ${region.baseUrl}` : undefined}
          >
            <Input
              mono
              value={draft.baseUrl}
              onValueChange={(baseUrl) => onChange({ baseUrl })}
              placeholder={region?.baseUrl}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
        </Disclosure>
      ) : null}

      {notes.length > 0 ? (
        <div className="rounded-xl bg-surface-2/70 px-4 py-3">
          <p className="text-xs font-semibold tracking-wide text-fg-muted uppercase">Good to know</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {notes.map((note) => (
              <li key={note} className="flex items-start gap-2 text-[13px] leading-5 text-fg-muted">
                <Info className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
                <span>{note}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {showKey && preset.kind !== 'cloud' ? (
        <p className="flex items-center gap-2 text-xs text-fg-subtle">
          <LockKeyhole className="size-3.5 shrink-0" aria-hidden="true" />
          Your key stays on this computer. Claude Setup never shows it again.
        </p>
      ) : null}
    </div>
  )
}
