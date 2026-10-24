/** Wizard step 2 (catalog tools): fields generated from the chosen install option, plus Advanced knobs. */
import { ShieldCheck } from 'lucide-react'
import type { CatalogServer, InstallOption } from '@shared/types'
import { Callout, Disclosure, Field, Input, OptionCard, OptionCardGroup, Select, Separator } from '@renderer/components/ui'
import { FieldGroup, ListEditor } from '../common/inputs'
import { optionRequirement, optionSelectLabel, optionTitle } from '../lib/catalog'
import { isRequired, type FormField, type FormValues } from '../lib/installForm'
import { SettingsField } from './SettingsField'

export interface StepSettingsProps {
  server: CatalogServer
  option: InstallOption
  onOptionChange: (optionId: string) => void
  fields: FormField[]
  values: FormValues
  onValuesChange: (values: FormValues) => void
  /** Field errors by key (already filtered: only shown after Next). */
  errors: Record<string, string>
  advanced: boolean
  name: string
  onNameChange: (name: string) => void
  nameError?: string
  extraArgs: string[]
  onExtraArgsChange: (args: string[]) => void
}

/** Settings form for a catalog tool. */
export function StepSettings(props: StepSettingsProps) {
  const { server, option, fields, values, errors, advanced } = props
  const required = fields.filter(isRequired)
  const optional = fields.filter((f) => !isRequired(f))
  const hasSecrets = fields.some((f) => f.secret)
  const many = server.install.length > 1

  const renderField = (field: FormField) => (
    <SettingsField
      key={field.key}
      field={field}
      value={values[field.key]}
      onChange={(value) => props.onValuesChange({ ...values, [field.key]: value })}
      error={errors[field.key]}
      advanced={advanced}
    />
  )

  return (
    <div className="space-y-5">
      {advanced && many ? (
        <Field label="How it runs" hint={optionRequirement(option)}>
          <Select
            value={option.id}
            onValueChange={props.onOptionChange}
            options={server.install.map((o) => ({ value: o.id, label: optionSelectLabel(o) }))}
          />
        </Field>
      ) : null}

      {option.notes ? (
        <Callout tone="neutral" className="py-3">
          {option.notes}
        </Callout>
      ) : null}

      {fields.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line-strong/70 px-4 py-5 text-center text-[13.5px] text-fg-muted">
          Nothing to fill in — {server.name} works as it is.
        </p>
      ) : null}

      {required.map(renderField)}

      {optional.length ? (
        advanced ? (
          <div className="space-y-5">
            {required.length ? <Separator /> : null}
            {optional.map(renderField)}
          </div>
        ) : (
          <Disclosure
            variant="card"
            title="Optional settings"
            description={`${optional.length} more`}
            defaultOpen={required.length === 0 || optional.some((f) => !!errors[f.key])}
          >
            <div className="space-y-5">{optional.map(renderField)}</div>
          </Disclosure>
        )
      ) : null}

      {!advanced && many ? (
        <Disclosure title="Run it a different way" description={optionTitle(option)}>
          <OptionCardGroup label="How it runs" type="radio" columns={1}>
            {server.install.map((o) => (
              <OptionCard
                key={o.id}
                type="radio"
                checked={o.id === option.id}
                onCheckedChange={() => props.onOptionChange(o.id)}
                title={optionTitle(o)}
                description={o.notes ?? optionRequirement(o)}
              />
            ))}
          </OptionCardGroup>
        </Disclosure>
      ) : null}

      {advanced ? (
        <div className="space-y-5">
          <Separator />
          <Field
            label="Name in the config"
            hint="Letters, numbers, “-” and “_”. Claude shows this name in its tool list."
            error={props.nameError}
            required
          >
            <Input mono value={props.name} onValueChange={props.onNameChange} spellCheck={false} autoComplete="off" />
          </Field>
          {option.kind !== 'remote' ? (
            <FieldGroup label="Extra arguments" optional hint="Added to the end of the command, one per row.">
              <ListEditor
                itemLabel="Argument"
                values={props.extraArgs}
                onChange={props.onExtraArgsChange}
                addLabel="Add argument"
                placeholder="--flag=value"
              />
            </FieldGroup>
          ) : null}
        </div>
      ) : null}

      {hasSecrets ? (
        <p className="flex items-start gap-2 text-[12.5px] leading-5 text-fg-muted">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success-text" aria-hidden="true" />
          Keys are saved only in your apps’ settings on this computer. Claude Setup never sends them anywhere else.
        </p>
      ) : null}
    </div>
  )
}
