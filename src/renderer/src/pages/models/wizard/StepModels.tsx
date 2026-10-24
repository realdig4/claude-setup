import { RefreshCw, TriangleAlert } from 'lucide-react'
import type { ModelPreset, ModelSlot, ProviderPreset } from '@shared/types'
import { Badge, Button, Chip, Disclosure, Field, Input, Separator, Switch } from '@renderer/components/ui'
import { cn } from '@renderer/lib/cn'
import { formatNumber, formatTokens } from '@renderer/lib/format'
import { KeyValueEditor } from '../KeyValueEditor'
import { ModelPicker } from '../ModelPicker'
import { MODEL_SLOTS, SLOT_LABELS, effectiveSlots, findModel, isRetiring, isUserDefined, modelFacts, parseTokenCount } from '../logic'
import { supportsKeyHelper, type ModelErrors, type WizardDraft } from './draft'

export interface StepModelsProps {
  preset: ProviderPreset
  draft: WizardDraft
  onChange: (patch: Partial<WizardDraft>) => void
  onMainChange: (main: string) => void
  /** Preset models merged with the ones loaded from the provider. */
  models: ModelPreset[]
  loadingModels: boolean
  onLoadModels: () => void
  errors: ModelErrors
  /** A key exists (typed or saved) — required for the key-helper option. */
  hasKey: boolean
  advanced: boolean
}

const CONTEXT_CHOICES = [131_072, 200_000, 262_144, 1_000_000]

function ModelInfo({ model }: { model: ModelPreset | undefined }) {
  if (!model) return null
  const facts = modelFacts(model, formatTokens)
  const retiring = isRetiring(model)
  if (facts.length === 0 && !model.notes) return null
  return (
    <div className="flex flex-col gap-1.5">
      {facts.length ? (
        <div className="flex flex-wrap gap-1.5">
          {facts.map((fact) => (
            <Badge key={fact} size="sm">
              {fact}
            </Badge>
          ))}
        </div>
      ) : null}
      {model.notes ? (
        <p className={cn('text-[12.5px] leading-5', retiring ? 'flex items-start gap-1.5 text-warn-text' : 'text-fg-muted')}>
          {retiring ? <TriangleAlert className="mt-[3px] size-3.5 shrink-0" aria-hidden="true" /> : null}
          <span>{model.notes}</span>
        </p>
      ) : null}
    </div>
  )
}

/** Step 2: pick the main and fast models (Advanced: every slot, context window, compatibility, extra env, key helper). */
export function StepModels(props: StepModelsProps) {
  const { preset, draft, onChange, onMainChange, models, loadingModels, onLoadModels, errors, hasKey, advanced } = props
  const userDefined = isUserDefined(preset)
  const mainModel = findModel(models, draft.main)
  const fastModel = findModel(models, draft.fast)
  const slots = effectiveSlots(preset, draft.main, draft.fast, draft.overrides)
  const canList = !!preset.listModels
  const contextPlaceholder = preset.contextWindow ?? mainModel?.context
  const contextValue = parseTokenCount(draft.contextWindow)
  const proxy = preset.kind === 'openai-proxy'

  const setOverride = (slot: ModelSlot, value: string): void => {
    const next = { ...draft.overrides }
    if (value.trim()) next[slot] = value
    else delete next[slot]
    onChange({ overrides: next })
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2.5">
        <Field label="Main model" hint="Used for your conversations." required error={errors.main}>
          <ModelPicker value={draft.main} onChange={onMainChange} options={models} size="lg" placeholder="model-name" />
        </Field>
        <ModelInfo model={mainModel} />
      </div>

      <div className="flex flex-col gap-2.5">
        <Field
          label="Fast model"
          hint="Used for quick background work like titles and summaries."
          error={errors.fast}
          optional={userDefined}
        >
          <ModelPicker
            value={draft.fast}
            onChange={(fast) => onChange({ fast })}
            options={models}
            emptyLabel={userDefined ? 'Same as the main model' : undefined}
            placeholder={userDefined ? 'Same as the main model' : 'model-name'}
          />
        </Field>
        {draft.fast && draft.fast !== draft.main ? <ModelInfo model={fastModel} /> : null}
      </div>

      {canList ? (
        <div
          className={cn(
            'flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-line-strong/70',
            'px-4 py-3'
          )}
        >
          <p className="text-[13px] text-fg-muted">
            {models.length > preset.models.length
              ? `${formatNumber(models.length)} models available from ${preset.name}.`
              : 'Not seeing the model you want?'}
          </p>
          <Button size="sm" leftIcon={RefreshCw} loading={loadingModels} onClick={onLoadModels}>
            Load models from {preset.name.replace(/\s*\(.*\)$/, '')}
          </Button>
        </div>
      ) : null}

      {advanced ? (
        <Disclosure
          title="Advanced settings"
          description="Every model slot, context window, compatibility and environment"
          variant="card"
          defaultOpen
        >
          <div className="flex flex-col gap-6">
            <section aria-labelledby="slots-heading" className="@container flex flex-col gap-3">
              <div>
                <h4 id="slots-heading" className="text-sm font-semibold text-fg">
                  Model slots
                </h4>
                <p className="text-[12.5px] leading-5 text-fg-muted">
                  Every slot is always filled, so background tasks never call a Claude model name your provider rejects.
                  Leave a slot on
                  “Follow” to use the choices above.
                </p>
              </div>
              <div className="grid gap-x-4 gap-y-3 @md:grid-cols-2">
                {MODEL_SLOTS.filter((slot) => slot !== 'main').map((slot) => (
                  <Field
                    key={slot}
                    label={SLOT_LABELS[slot].label}
                    hint={<span className="font-mono text-[11.5px]">{SLOT_LABELS[slot].env}</span>}
                    error={errors.slots?.[slot]}
                  >
                    <ModelPicker
                      size="sm"
                      value={draft.overrides[slot] ?? ''}
                      onChange={(value) => setOverride(slot, value)}
                      options={models}
                      emptyLabel={`Follow (${slots[slot] || 'main model'})`}
                    />
                  </Field>
                ))}
              </div>
            </section>

            <Separator />

            <Field
              label="Context window"
              optional
              error={errors.contextWindow}
              hint={
                contextValue
                  ? `≈ ${formatTokens(contextValue)} tokens. Claude Code compacts the conversation before it gets this long.`
                  : contextPlaceholder
                    ? `Leave empty to use ${formatTokens(contextPlaceholder)} (the provider’s recommendation).`
                    : 'How many tokens the model can read at once. Leave empty if you’re not sure.'
              }
            >
              <Input
                mono
                inputMode="numeric"
                value={draft.contextWindow}
                onValueChange={(contextWindow) => onChange({ contextWindow })}
                placeholder={contextPlaceholder ? String(contextPlaceholder) : '262144'}
              />
            </Field>
            <div className="-mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Common context sizes">
              {CONTEXT_CHOICES.map((tokens) => (
                <Chip
                  key={tokens}
                  size="sm"
                  selected={contextValue === tokens}
                  onClick={() => onChange({ contextWindow: String(tokens) })}
                >
                  {formatTokens(tokens)}
                </Chip>
              ))}
            </div>

            <Separator />

            <Switch
              checked={proxy ? true : draft.compatMode}
              disabled={proxy}
              onCheckedChange={(compatMode) => onChange({ compatMode, compatTouched: true })}
              label="Compatibility mode"
              description={
                proxy
                  ? 'Always on for providers that go through the proxy.'
                  : 'Turns off newer Claude-only features (tool search, experimental betas) and background traffic such as ' +
                    'auto-updates and telemetry, so other providers don’t reject requests. Recommended for non-Claude models.'
              }
            />

            <Separator />

            <section aria-labelledby="env-heading" className="flex flex-col gap-2">
              <div>
                <h4 id="env-heading" className="text-sm font-semibold text-fg">
                  Extra environment variables
                </h4>
                <p className="text-[12.5px] leading-5 text-fg-muted">Written to Claude Code’s settings together with this setup.</p>
              </div>
              {preset.extraEnv && Object.keys(preset.extraEnv).length ? (
                <p className="text-[12.5px] leading-5 text-fg-muted">
                  {preset.name} also sets{' '}
                  {Object.entries(preset.extraEnv).map(([key, value], i) => (
                    <span key={key}>
                      {i > 0 ? ', ' : ''}
                      <code className="rounded bg-surface-3/70 px-1 font-mono text-[11.5px] text-fg">
                        {key}={value}
                      </code>
                    </span>
                  ))}
                  .
                </p>
              ) : null}
              <KeyValueEditor
                label="Extra environment variables"
                rows={draft.extraEnv}
                onChange={(extraEnv) => onChange({ extraEnv })}
                errors={errors.env}
                keyLabel="Variable"
                valueLabel="Value"
                keyPlaceholder="NAME"
                addLabel="Add variable"
              />
            </section>

            {supportsKeyHelper(preset) ? (
              <>
                <Separator />
                <Switch
                  checked={draft.useKeyHelper}
                  disabled={!hasKey}
                  onCheckedChange={(useKeyHelper) => onChange({ useKeyHelper })}
                  label="Keep the key out of Claude Code’s settings file"
                  description={
                    hasKey
                      ? 'Claude Code asks Claude Setup for the key when it starts (apiKeyHelper). ' +
                        'Needs the claude-setup terminal command — install it in Settings.'
                      : 'Add an API key first.'
                  }
                />
              </>
            ) : null}
          </div>
        </Disclosure>
      ) : null}
    </div>
  )
}
